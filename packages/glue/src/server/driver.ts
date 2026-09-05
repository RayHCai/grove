// Real time into ticks, for the in-process host. The Rust host at `apps/grove/host` owns the same
// policy over its own clock; this is the copy the tests, the playground and local dev run on.
//
// It drives nothing itself: `pump` reports the ticks real time owes and the caller runs them, which
// is what keeps the batch loop — the part that answers the sim's loads and saves — on one side of the
// seam rather than behind a callback the driver owns.

/** Slack on the accumulator's `>= dt` test: a host advancing by exactly `1 / simRate` rounds short, and a wake owing one tick would step zero times. */
const STEP_EPSILON = 1e-9;

/** Wall-clock one wake may catch up before it sheds, sized so a backgrounded tab drains without shedding. */
export const MAX_CATCHUP_MS = 250;

/** Ticks one wake may step before it sheds the rest as wall-clock. */
export function maxStepsPerWake(simRate: number): number {
    return Math.max(1, Math.ceil((MAX_CATCHUP_MS / 1000) * simRate));
}

/** Ticks between broadcasts, never below one. */
export function ticksPerSend(simRate: number, sendRate: number): number {
    if (!(sendRate > 0)) return 1;
    return Math.max(1, Math.round(simRate / sendRate));
}

/** Why the driver refused. The code, not the message, is what a host branches on. */
export type HostErrorCode = 'invalid-config';

/** A host failure with a machine-readable {@link HostErrorCode}. */
export class HostError extends Error {
    readonly code: HostErrorCode;

    constructor(code: HostErrorCode, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'HostError';
        this.code = code;
    }
}

/** Throws unless `rate` is a positive finite number — nothing upstream validates a resolved default. */
export function assertRate(name: string, rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) {
        throw new HostError(
            'invalid-config',
            `${name} must be a positive finite number, received ${rate}`,
        );
    }
}

/** What the driver drives — an interface, so it needs no runtime. */
export interface DriverHooks {
    /** One tick, and the passes inside it. `drain` marks a send-tick. */
    stepOnce(drain: boolean): void;
}

export interface DriverOptions {
    simRate: number;
    sendRate: number;
    /** Flushes inbound frames into the sessions' handlers, before this wake's steps. */
    deliver?: () => void;
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

    #simRate: number;
    #sendRate: number;
    #accumulator = 0;
    #lastNow: number | null = null;
    /** Ticks since the last broadcast, counted here rather than derived from the tick index. */
    #sinceSend = 0;
    #shedCount = 0;
    #nowSeconds = 0;

    constructor(hooks: DriverHooks, opts: DriverOptions) {
        assertRate('simRate', opts.simRate);
        assertRate('sendRate', opts.sendRate);
        this.#hooks = hooks;
        this.#deliver = opts.deliver;
        this.#simRate = opts.simRate;
        this.#sendRate = opts.sendRate;
    }

    /** The clock the last `pump` reported — the host's only reading of time. */
    get nowSeconds(): number {
        return this.#nowSeconds;
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
        // Clamped rather than subtracted: an NTP correction or a restored VM snapshot arrives as a
        // reading behind the last one, and a negative delta would rewind the accumulator.
        this.#accumulator += Math.max(0, nowSeconds - this.#lastNow);
        this.#lastNow = nowSeconds;

        const cap = maxStepsPerWake(this.#simRate);
        const perSend = ticksPerSend(this.#simRate, this.#sendRate);

        const owed = dt - STEP_EPSILON;
        let steps = 0;
        let sends = 0;
        while (this.#accumulator >= owed && steps < cap) {
            this.#accumulator -= dt;
            this.#sinceSend += 1;
            const drain = this.#sinceSend >= perSend;
            if (drain) this.#sinceSend = 0;
            this.#hooks.stepOnce(drain);
            steps += 1;
            if (drain) sends += 1;
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
}
