/** Why a session ended terminally. */
export type FailureReason =
    | { kind: 'rejected'; reason: string; serverProtocolVersion: number }
    /** A `Welcome` the client cannot use: no reason field to read, and no retry helps. */
    | { kind: 'undecodable' }
    /** `encode-rejected` — our bug, and it must surface loudly. */
    | { kind: 'internal'; message: string }
    /** A peer that did not hold up its end: bad frames, a throw, or a join never answered. */
    | { kind: 'peer'; message: string }
    /** The script bundle would not load, or was not the bundle the server said it would be. */
    | { kind: 'bundle'; message: string };

export type SessionState =
    /** `JoinRequest` sent, no `Welcome` yet. Input refused. */
    | 'connecting'
    /** `Welcome` accepted, bundle still fetching. Input refused; later envelopes are held. */
    | 'loading'
    /** `Welcome` applied, clock seeded. Input accepted. */
    | 'live'
    /** No envelope for `STALL_SECONDS`, or `ackSeq` frozen. Input refused; the pose holds. */
    | 'stalled'
    /** `localTick < depictedTick`, or a `RateChange`. Input refused. */
    | 'resyncing'
    /** `onClose` fired — clean, dropped, or refused. Input refused. */
    | 'disconnected'
    /** Terminal, with a reason. */
    | 'failed';

/** Whether input may be captured; `stalled` refuses so stopped prediction banks nothing. */
export function acceptsInput(state: SessionState): boolean {
    return state === 'live';
}

/** Terminal states: nothing further arrives and the frame source should stop. */
export function isTerminal(state: SessionState): boolean {
    return state === 'failed' || state === 'disconnected';
}

/** Not a transition table: the few legal moves are each named at their call site. */
export class Lifecycle {
    #state: SessionState = 'connecting';
    #failure: FailureReason | undefined;
    readonly #listeners = new Set<(state: SessionState) => void>();
    /** Reused, so a listener subscribing or unsubscribing cannot alter the dispatch it is in. */
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

    /** Moves to `state` unless already terminal — a closed session does not become `live`. */
    to(state: SessionState): void {
        if (isTerminal(this.#state)) return;
        this.#move(state);
    }

    /** Ends the session with a reason, from any state — the one move terminal does not absorb. */
    fail(reason: FailureReason): void {
        // Recorded even on a repeat call: the first reason is the interesting one.
        this.#failure ??= reason;
        this.#move('failed');
    }

    #move(state: SessionState): void {
        if (this.#state === state) return;
        this.#state = state;

        this.#dispatching.length = 0;
        for (const listener of this.#listeners) this.#dispatching.push(listener);
        // A throwing listener must not cost the others their notification.
        for (const listener of this.#dispatching) {
            try {
                listener(state);
            } catch {
                /* a listener's failure is its own */
            }
        }
        this.#dispatching.length = 0;
    }
}
