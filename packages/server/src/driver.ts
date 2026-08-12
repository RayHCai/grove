// The driver: real time → ticks, the spiral guard, send-tick accounting, and the deliver→step order.
//
// This is the layer that advances real time into ticks, but off an injected clock — `pump(now)`, or an
// injected `TimerSource` when it self-drives — so the whole server is testable against a scripted
// clock with no wall-clock and no socket.
//
// It takes the deliver callback and calls it itself, first, inside `pump`. Reversed, that ordering
// still runs and nothing reports it, costing every input one tick of latency that is invisible in
// loopback and a real floor in production; a pump that owns the sequence cannot be called out of order.

import type { TimerSource } from '@platform/transport';
import { assertRate, maxStepsPerWake, ticksPerSend } from './constants.js';

/**
 * Slack on the accumulator's `>= dt` test, in seconds.
 *
 * A host advancing its clock by `1 / simRate` per wake does not accumulate exactly `dt` — the
 * subtraction rounds, so a wake owing one tick can measure 0.99999999999 of one and step zero times.
 * A nanosecond is fifty thousand times smaller than a tick at 60 Hz, so it cannot mask a real
 * shortfall.
 */
const STEP_EPSILON = 1e-9;

/** What the driver drives. Both are stubbed in the driver's own tests, so it needs no runtime. */
export interface DriverHooks {
    /** One tick, and the passes inside it. */
    stepOnce(): void;
    /** A send-tick: drain the three channels and broadcast. */
    send(): void;
}

export interface DriverOptions {
    simRate: number;
    sendRate: number;
    /**
     * Flush inbound frames into the connections' handlers, before this wake's steps.
     *
     * `pair.deliver` in loopback; omitted networked, where the socket's own event loop has already
     * dispatched inbound. Mode-awareness is this one optional field — a value, not an obligation.
     */
    deliver?: () => void;
    /** The scheduling seam for {@link Driver.start}. */
    timer?: TimerSource;
    /**
     * The clock {@link Driver.start} reads, for the self-driven mode only.
     *
     * `TimerSource` schedules but does not tell the time, and without a clock a self-driven wake can
     * only assume its interval fired on time — so a late callback under-advances the world with
     * nothing to notice. Absent, the interval is the clock: a fixed-step loop with no drift
     * correction, correct while the host keeps up.
     */
    now?: () => number;
}

/** What one `pump` did, so a test reads the accumulator's behaviour rather than inferring it. */
export interface PumpResult {
    steps: number;
    sends: number;
    /** True when the cap was hit with backlog left over, and that backlog was shed. */
    shed: boolean;
}

export class Driver {
    readonly #hooks: DriverHooks;
    readonly #deliver: (() => void) | undefined;
    readonly #timer: TimerSource | undefined;
    readonly #now: (() => number) | undefined;

    #simRate: number;
    #sendRate: number;
    #accumulator = 0;
    #lastNow: number | null = null;
    /** Ticks since the last broadcast, counted here rather than derived from the tick index. */
    #sinceSend = 0;
    #shedCount = 0;
    #handle: unknown = null;
    #nowSeconds = 0;

    constructor(hooks: DriverHooks, opts: DriverOptions) {
        assertRate('simRate', opts.simRate);
        assertRate('sendRate', opts.sendRate);
        this.#hooks = hooks;
        this.#deliver = opts.deliver;
        this.#timer = opts.timer;
        this.#now = opts.now;
        this.#simRate = opts.simRate;
        this.#sendRate = opts.sendRate;
    }

    /** The clock the last `pump` reported — the server's only reading of time. */
    get nowSeconds(): number {
        return this.#nowSeconds;
    }

    /**
     * Whether any finite reading has been taken. `nowSeconds` is a placeholder until it has, and a
     * caller differencing against that placeholder is asserting the clock's epoch is zero.
     */
    get hasReading(): boolean {
        return this.#lastNow !== null;
    }

    /** Unsimulated real time still owed, in seconds. */
    get accumulator(): number {
        return this.#accumulator;
    }

    /** How many times the step cap has shed a backlog — a visible slowdown, not a silent one. */
    get shedCount(): number {
        return this.#shedCount;
    }

    /** Keeping the cadence here rather than deriving it from the tick index is what stops a mid-session rate change desyncing it. */
    setRates(simRate: number, sendRate: number): void {
        assertRate('simRate', simRate);
        assertRate('sendRate', sendRate);
        this.#simRate = simRate;
        this.#sendRate = sendRate;
    }

    /** One wake: deliver inbound, then advance real time into ticks. */
    pump(nowSeconds: number): PumpResult {
        this.#deliver?.();

        // Discarded, never stored: stored, every later `now - lastNow` is NaN, so one bad reading
        // from a host freezes the counter for the session rather than for a wake.
        if (!Number.isFinite(nowSeconds)) return { steps: 0, sends: 0, shed: false };

        this.#nowSeconds = nowSeconds;
        if (this.#lastNow === null) this.#lastNow = nowSeconds;

        const dt = 1 / this.#simRate;
        // A rewind runs zero steps rather than integrating a negative interval.
        this.#accumulator += Math.max(0, nowSeconds - this.#lastNow);
        this.#lastNow = nowSeconds;

        const cap = maxStepsPerWake(this.#simRate);
        const perSend = ticksPerSend(this.#simRate, this.#sendRate);

        const owed = dt - STEP_EPSILON;
        let steps = 0;
        let sends = 0;
        while (this.#accumulator >= owed && steps < cap) {
            this.#accumulator -= dt;
            this.#hooks.stepOnce();
            steps += 1;
            this.#sinceSend += 1;
            if (this.#sinceSend >= perSend) {
                this.#sinceSend = 0;
                this.#hooks.send();
                sends += 1;
            }
        }

        // The cap hit with backlog left: shed the unsimulated real time so the server never spirals.
        // The tick counter does not jump — `stepOnce` steps `tick + 1`, so shed time advances no tick
        // and the world falls behind wall-clock rather than skipping to it. Forced by core, not
        // preferred: timers and tweens advance one unit per step call ignoring the index and `dt` is
        // always `1 / simRate`, so stepping `tick + N` would compress every delay and tween by the gap.
        //
        // Conditioned on leftover backlog: a wake that needed exactly the cap and drained cleanly has
        // nothing to shed, and zeroing there would discard a legitimate fractional remainder.
        const shed = steps === cap && this.#accumulator >= owed;
        if (shed) {
            this.#accumulator = 0;
            this.#shedCount += 1;
        }

        return { steps, sends, shed };
    }

    /** Networked: self-drive off the injected timer. Idempotent; throws if no timer was injected. */
    start(): void {
        if (this.#timer === undefined) {
            throw new Error(
                'Driver.start() needs an injected TimerSource; a host-pumped server calls pump(now) instead.',
            );
        }
        if (this.#handle !== null) return;
        const ms = 1000 / this.#simRate;
        const read = this.#now;
        this.#handle = this.#timer.setInterval(() => {
            // With no clock the interval is the clock: each fire is charged exactly one tick, which
            // is a fixed-step loop with no drift correction rather than a wrong one.
            this.pump(read === undefined ? this.#nowSeconds + ms / 1000 : read());
        }, ms);
    }

    stop(): void {
        if (this.#handle === null || this.#timer === undefined) return;
        this.#timer.clearInterval(this.#handle);
        this.#handle = null;
    }
}
