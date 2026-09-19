// Display rate and tick rate stay separate: fusing them would tie input timing to frame rate.

import {
    GAIN,
    HEADROOM_TARGET,
    LEAD_MAX_SECONDS,
    LEAD_MIN_TICKS,
    MAX_FRAME_DT,
    NUDGE_MAX,
} from './constants.js';

/** What the server measured about one acked frame. */
export interface HeadroomSample {
    /** `frame.tick - serverTickOnArrival` for the earliest input in the acked batch. Signed. */
    headroom: number;
    /** `currentLeadTicks` when that frame was sent — the instant `headroom` describes. */
    leadAtSendTicks: number;
}

export class ClientClock {
    readonly #simRate: number;

    /** The input tick. Ahead of the server's; every index stamped exactly once, in order. */
    #localTick: number;

    #accumulator = 0;
    #lastNow: number | undefined;

    /** Where the loop wants the lead. Seconds, converted to ticks on demand. */
    #targetLeadSeconds: number;

    /** Bookkeeping, not measurement: it moves only by the time the nudge inserted or removed. */
    #currentLeadSeconds: number;

    /** Bumped on entering `stalled` and on resync; the headroom discard keys on it. */
    #epoch = 0;

    constructor(opts: { simRate: number; snapshotTick: number; rttSeconds: number }) {
        this.#simRate = opts.simRate;

        // One RTT, unhalved: reaching server-now costs one one-way trip and server-future another.
        const seed = clampLead(opts.rttSeconds, this.#simRate);
        this.#targetLeadSeconds = seed;
        this.#currentLeadSeconds = seed;
        this.#localTick = opts.snapshotTick + Math.ceil(seed * this.#simRate);
    }

    get simRate(): number {
        return this.#simRate;
    }

    get localTick(): number {
        return this.#localTick;
    }

    get epoch(): number {
        return this.#epoch;
    }

    get targetLeadSeconds(): number {
        return this.#targetLeadSeconds;
    }

    get currentLeadSeconds(): number {
        return this.#currentLeadSeconds;
    }

    get currentLeadTicks(): number {
        return this.#currentLeadSeconds * this.#simRate;
    }

    /** Both terms are bookkeeping, so this is exact. */
    get leadError(): number {
        return this.#targetLeadSeconds - this.#currentLeadSeconds;
    }

    bumpEpoch(): void {
        this.#epoch++;
    }

    /** Advances the tick one frame, returning indices to stamp; the nudge alters duration only. */
    advance(nowSeconds: number, out: number[] = []): number[] {
        out.length = 0;

        // Discarded rather than stored: one stored NaN would freeze the counter for the session.
        if (!Number.isFinite(nowSeconds)) return out;

        const raw = this.#lastNow === undefined ? 0 : nowSeconds - this.#lastNow;
        this.#lastNow = nowSeconds;

        // Backwards clocks are inert; the clamp is why a suspended tab falls behind.
        const dt = Math.min(Math.max(0, raw), MAX_FRAME_DT);
        this.#accumulator += dt;

        const nominal = 1 / this.#simRate;
        const step = nominal * this.#nudgeScale();

        while (this.#accumulator >= step) {
            this.#accumulator -= step;
            this.#localTick++;
            out.push(this.#localTick);
            // The lead changed by exactly the time this tick did not take.
            this.#currentLeadSeconds += nominal - step;
        }

        return out;
    }

    /** A short tick makes the counter advance sooner, so a positive `leadError` shortens it. */
    #nudgeScale(): number {
        const halfTick = 0.5 / this.#simRate;
        const error = this.leadError;
        if (Math.abs(error) <= halfTick) return 1;
        return error > 0 ? 1 - NUDGE_MAX : 1 + NUDGE_MAX;
    }

    /** Steers the target lead off one headroom sample; `effectiveHeadroom` prevents windup. */
    sample(s: HeadroomSample): void {
        const targetLeadTicks = this.#targetLeadSeconds * this.#simRate;
        const undelivered = targetLeadTicks - s.leadAtSendTicks;
        const effectiveHeadroom = s.headroom + undelivered;
        const error = HEADROOM_TARGET - effectiveHeadroom;

        this.#targetLeadSeconds = clampLead(
            this.#targetLeadSeconds + (GAIN * error) / this.#simRate,
            this.#simRate,
        );
    }

    /** Whether the counter left the timeline, as a suspended tab does. A sign test. */
    isBehind(depictedTick: number): boolean {
        return this.#localTick < depictedTick;
    }
}

/** The legal lead range: 1 tick to 250 ms — 14 ticks wide at 60 Hz, 4 at 20 Hz, correct at both. */
function clampLead(seconds: number, simRate: number): number {
    const min = LEAD_MIN_TICKS / simRate;
    if (!Number.isFinite(seconds)) return min;
    return Math.min(Math.max(seconds, min), LEAD_MAX_SECONDS);
}

export { clampLead };
