/** Why a session ended terminally. */
export type FailureReason =
    | { kind: 'rejected'; reason: string; serverProtocolVersion: number }
    /** A `Welcome` the client cannot use: no reason field to read, and no retry helps. */
    | { kind: 'undecodable' }
    /** `encode-rejected`: our bug, and it must surface loudly. */
    | { kind: 'internal'; message: string }
    /** A peer that did not hold up its end: bad frames, a throw, or a join never answered. */
    | { kind: 'peer'; message: string }
    /** The script bundle would not load, or was not the bundle the server said it would be. */
    | { kind: 'bundle'; message: string };

/** Why a session closed without failing, read once it is `disconnected`. */
export type DisconnectReason =
    | { kind: 'closed' }
    /** No frame for `idleSeconds` when the close came: a hidden page the host dropped as silent. */
    | { kind: 'frames-stopped'; idleSeconds: number };

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
    /** `onClose` fired: clean, dropped, or refused. Input refused. */
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
    #disconnection: DisconnectReason | undefined;
    readonly #listeners = new Set<(state: SessionState) => void>();

    get state(): SessionState {
        return this.#state;
    }

    get failure(): FailureReason | undefined {
        return this.#failure;
    }

    /** Set once, by the move into `disconnected`; a session that failed never has one. */
    get disconnection(): DisconnectReason | undefined {
        return this.#disconnection;
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

    /** Moves to `state` unless already terminal; a closed session does not become `live`. */
    to(state: SessionState): void {
        if (isTerminal(this.#state)) return;
        this.#move(state);
    }

    /** Moves to `disconnected` with a reason, unless already terminal. */
    disconnect(reason: DisconnectReason): void {
        if (isTerminal(this.#state)) return;
        // Before the move, so a listener told `disconnected` can already read why.
        this.#disconnection = reason;
        this.#move('disconnected');
    }

    /** Ends the session with a reason, from any state, the one move terminal does not absorb. */
    fail(reason: FailureReason): void {
        // Recorded even on a repeat call: the first reason is the interesting one.
        this.#failure ??= reason;
        this.#move('failed');
    }

    #move(state: SessionState): void {
        if (this.#state === state) return;
        this.#state = state;

        // Snapshotted per notify, so a listener that subscribes, unsubscribes or moves the state
        // again cannot alter the dispatch it is in; a throwing one costs the others nothing.
        for (const listener of Array.from(this.#listeners)) {
            try {
                listener(state);
            } catch {
                /* a listener's failure is its own */
            }
        }
    }
}
