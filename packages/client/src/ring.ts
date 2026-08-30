// The ring of unacknowledged input, and the horizon state a replay starts from.
//
// Edges-only breaks replay-sufficiency, and the fix is to fold at the prune: the press that established a
// hold may have been pruned long before the replay's start tick, and neither `since()` nor core's snapshot
// can say it was held. A "last edge per action" map does not fix it — it holds the most recent edge, which
// is frequently after the replay's start.

import type { ActionStates } from '@platform/core';
import { createActionStates } from '@platform/core';
import type { InputFrame } from '@platform/protocol';
import { RING_TICKS } from './constants.js';

/** One retained frame, plus the clock bookkeeping the lead loop reads back on its ack. */
export interface RingEntry {
    frame: InputFrame;
    /** `currentLeadTicks` when this frame was sent — the instant `headroom` describes. */
    leadAtSendTicks: number;
    /** The clock epoch at send; a sample from a superseded epoch is discarded. */
    epoch: number;
}

/**
 * Restates `from`'s held buttons and non-neutral axes into `into`, then closes the tick.
 *
 * A rebuilt fold asserts held state rather than a transition, and edges are one tick wide — so the
 * `advanceTick` is part of the operation, not a caller's afterthought.
 */
export function assertHeld(from: ActionStates, into: ActionStates): void {
    for (const action of from.heldActions()) into.applyEdge({ action, on: 'press' });
    for (const { action, value } of from.axisValues()) {
        into.applyEdge({ action, on: 'hold', value });
    }
    into.advanceTick();
}

export class InputRing {
    readonly #entries: RingEntry[] = [];
    #heldAtHorizon: ActionStates = createActionStates();
    #horizonTick = -1;
    #droppedToOverflow = 0;

    push(frame: InputFrame, leadAtSendTicks: number, epoch: number): void {
        if (this.#entries.length >= RING_TICKS) {
            // Deliberately not `stalled`, which refuses input: that would turn a burst of ordinary play
            // into dead controls. What is lost is replay history, which costs the MVP nothing.
            const dropped = this.#entries.shift();
            if (dropped) this.#fold(dropped);
            this.#droppedToOverflow++;
        }
        this.#entries.push({ frame, leadAtSendTicks, epoch });
    }

    /**
     * Drops everything at or below `seq` — resolved, applied or refused — folding each into the horizon.
     *
     * Returns the earliest entry pruned, because that is the frame `earliestHeadroom` describes; returning
     * the entry at `seq` would pair the compensation with the wrong instant. A refused frame still folds
     * in, because the client sent it and its own `ActionStates` acted on it.
     */
    ack(seq: number): RingEntry | undefined {
        let earliest: RingEntry | undefined;
        while (this.#entries.length > 0) {
            const head = this.#entries[0] as RingEntry;
            if (head.frame.seq > seq) break;
            this.#entries.shift();
            earliest ??= head;
            this.#fold(head);
        }
        return earliest;
    }

    /** Oldest-first, for the replay that lands with prediction. */
    since(tick: number): readonly InputFrame[] {
        return this.#entries.filter((e) => e.frame.tick >= tick).map((e) => e.frame);
    }

    /** Every retained frame, oldest-first, into a caller-owned array — a replay reads this per frame. */
    frames(out: InputFrame[] = []): InputFrame[] {
        out.length = 0;
        for (const entry of this.#entries) out.push(entry.frame);
        return out;
    }

    /** Valid for any tick in `[horizonTick, horizonValidUntil)` — an interval, never an equality. */
    get heldAtHorizon(): ActionStates {
        return this.#heldAtHorizon;
    }

    get horizonTick(): number {
        return this.#horizonTick;
    }

    /** The oldest frame still unacked, or `Infinity`. */
    get horizonValidUntil(): number {
        return this.#entries[0]?.frame.tick ?? Number.POSITIVE_INFINITY;
    }

    /** Diagnostic counter, deliberately not a lifecycle trigger. */
    get droppedToOverflow(): number {
        return this.#droppedToOverflow;
    }

    get size(): number {
        return this.#entries.length;
    }

    get oldestSeq(): number | undefined {
        return this.#entries[0]?.frame.seq;
    }

    /**
     * Rebuilds the horizon, since the old one names a tick in abandoned numbering.
     *
     * Correct by construction: what is physically held did not change because the session's clock did, so
     * the caller seeds from the live `ActionStates`.
     */
    reset(live?: ActionStates): void {
        this.#entries.length = 0;
        this.#horizonTick = -1;
        this.#heldAtHorizon = createActionStates();
        if (live) assertHeld(live, this.#heldAtHorizon);
    }

    #fold(entry: RingEntry): void {
        // The boundary comes first: `pressed`/`released` from the previous folded frame are one tick wide.
        this.#heldAtHorizon.advanceTick();
        for (const action of entry.frame.actions) {
            this.#heldAtHorizon.applyEdge(action);
        }
        this.#horizonTick = entry.frame.tick;
    }
}
