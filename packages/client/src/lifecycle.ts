// The lifecycle state machine. The client is the only package with a person watching, so its states are a
// surface, not a log.

/** Why a session ended terminally. */
export type FailureReason =
    | { kind: 'rejected'; reason: string; serverProtocolVersion: number }
    /** A `Welcome` the client cannot use: no reason field to read, and no retry helps. */
    | { kind: 'undecodable' }
    /** `encode-rejected` — our bug, and it must surface loudly. */
    | { kind: 'internal'; message: string }
    /** A malformed or hostile peer: bad frames, or an envelope that threw while applying. */
    | { kind: 'peer'; message: string };

export type SessionState =
    /** `JoinRequest` sent, no `Welcome` yet. Input refused. */
    | 'connecting'
    /** `Welcome` applied, clock seeded. Input accepted. */
    | 'live'
    /** No envelope for `STALL_SECONDS`, or `ackSeq` frozen. Input refused; the world holds its pose. */
    | 'stalled'
    /** `localTick < depictedTick`, or a `RateChange`. Input refused. */
    | 'resyncing'
    /** `onClose` fired — clean, dropped, or refused. Input refused. */
    | 'disconnected'
    /** Terminal, with a reason. */
    | 'failed';

/**
 * Whether input may be captured and sent in this state.
 *
 * `stalled` refuses it so a player cannot accumulate ghost gameplay: without prediction the world freezes,
 * so mashing keys would fill the ring with inputs the server will refuse as too old. Synthetic releases are
 * exempt at the call site — a release can only ever end ghost gameplay.
 */
export function acceptsInput(state: SessionState): boolean {
    return state === 'live';
}

/** Terminal states: nothing further arrives and the frame source should stop. */
export function isTerminal(state: SessionState): boolean {
    return state === 'failed' || state === 'disconnected';
}

/**
 * Deliberately not a transition table: the legal moves are few and each is named at its call site with the
 * evidence that justified it, which is what anything able to refuse input owes a reader.
 */
export class Lifecycle {
    #state: SessionState = 'connecting';
    #failure: FailureReason | undefined;
    readonly #listeners = new Set<(state: SessionState) => void>();
    /** Reused, so a listener that subscribes or unsubscribes cannot alter the dispatch it is inside. */
    readonly #dispatching: Array<(state: SessionState) => void> = [];

    get state(): SessionState {
        return this.#state;
    }

    get failure(): FailureReason | undefined {
        return this.#failure;
    }

    get acceptsInput(): boolean {
        return acceptsInput(this.#state);
    }

    onChange(listener: (state: SessionState) => void): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** Moves to `state`, unless already terminal — a `failed` client does not become `disconnected`. */
    to(state: SessionState): void {
        if (this.#state === state) return;
        if (this.#state === 'failed') return;
        this.#state = state;

        this.#dispatching.length = 0;
        for (const listener of this.#listeners) this.#dispatching.push(listener);
        // A throwing listener must not cost the others their notification, nor unwind into the frame loop.
        for (const listener of this.#dispatching) {
            try {
                listener(state);
            } catch {
                /* a listener's failure is its own */
            }
        }
        this.#dispatching.length = 0;
    }

    fail(reason: FailureReason): void {
        // Recorded even on a repeat call: the first reason is the interesting one, and `to` refuses.
        this.#failure ??= reason;
        this.to('failed');
    }
}
