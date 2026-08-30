import type { TimerSource } from '@platform/transport';
import { assertRate, maxStepsPerWake, ticksPerSend } from './constants.js';
import { ServerError } from './errors.js';

/** Slack on the accumulator's `>= dt` test: a host advancing by exactly `1 / simRate` rounds short, and a wake owing one tick would step zero times. */
const STEP_EPSILON = 1e-9;

/** What the driver drives — an interface, so it needs no runtime. */
export interface DriverHooks {
    /** One tick, and the passes inside it. */
    stepOnce(): void;
    /** A send-tick: drain the three channels and broadcast. */
    send(): void;
}

export interface DriverOptions {
    simRate: number;
    sendRate: number;
    /** Flushes inbound frames into the connections' handlers, before this wake's steps. */
    deliver?: () => void;
    /** The scheduling seam for {@link Driver.start}. */
    timer?: TimerSource;
    /** The clock {@link Driver.start} reads; absent, the interval is the clock — a fixed-step loop with no drift correction. */
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

    /** Whether any finite reading has been taken — `nowSeconds` is a placeholder until it has, and the clock's epoch is unknown. */
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

    /** Retunes both rates; the cadence lives here rather than on the tick index so a mid-session change cannot desync it. */
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
        // freezes the counter for the session rather than for a wake.
        if (!Number.isFinite(nowSeconds)) return { steps: 0, sends: 0, shed: false };

        this.#nowSeconds = nowSeconds;
        if (this.#lastNow === null) this.#lastNow = nowSeconds;

        const dt = 1 / this.#simRate;
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

        // Conditioned on leftover backlog: a wake that needed exactly the cap and drained cleanly has
        // a legitimate fractional remainder that zeroing would discard.
        const shed = steps === cap && this.#accumulator >= owed;
        if (shed) {
            this.#accumulator = 0;
            this.#shedCount += 1;
        }

        return { steps, sends, shed };
    }

    /** Networked: self-drive off the injected timer. Idempotent; throws if no timer was injected. */
    start(): void {
        const timer = this.#timer;
        if (timer === undefined) {
            throw new ServerError(
                'no-timer',
                'Driver.start() needs an injected TimerSource; a host-pumped server calls pump(now) instead.',
            );
        }
        if (this.#handle !== null) return;
        const ms = 1000 / this.#simRate;
        const read = this.#now;
        this.#handle = timer.setInterval(() => {
            this.pump(read === undefined ? this.#nowSeconds + ms / 1000 : read());
        }, ms);
    }

    stop(): void {
        if (this.#handle === null || this.#timer === undefined) return;
        this.#timer.clearInterval(this.#handle);
        this.#handle = null;
    }
}
