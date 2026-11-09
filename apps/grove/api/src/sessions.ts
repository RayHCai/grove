import type { Session } from 'fastify';
import type { SessionStore } from '@fastify/session';
import type { PlayerId } from '@grove/api-contract';

// Only a sign-in inserts: `set` updates a held session, never creates one, so a request in flight
// when a session is revoked has nothing to write back into.
export interface Sessions extends SessionStore {
    /** Holds a session a sign-in just minted, which is the one way a session comes to exist. */
    open(sessionId: string, session: Session): Promise<void>;
    /** Revokes every session one account holds, the caller's own among them. */
    destroyFor(player: PlayerId): Promise<void>;
    /** Drops what has expired; a read already refuses it, so this bounds the store and no more. */
    prune(): Promise<void>;
}

/** What one process should hold at once, and few enough that a flood cannot exhaust its heap. */
const MAX_LIVE_SESSIONS = 50_000;

/** When a held session stops answering, which a rolling cookie moves on with every request. */
export function expiryOf(session: Session, ttlMs: number): Date {
    return session.cookie.expires ?? new Date(Date.now() + ttlMs);
}

/** Sessions held in this process, for a deploy with no database, where nothing persists anyway. */
export class MemorySessions implements Sessions {
    readonly #ttlMs: number;
    readonly #cap: number;
    // Insertion order is expiry order, because every write re-inserts.
    readonly #held = new Map<string, { session: Session; expiresAt: number }>();

    constructor(ttlMs: number, cap: number = MAX_LIVE_SESSIONS) {
        this.#ttlMs = ttlMs;
        this.#cap = cap;
    }

    async open(sessionId: string, session: Session): Promise<void> {
        this.#hold(sessionId, session);
    }

    set(sessionId: string, session: Session, callback: (error?: unknown) => void): void {
        if (this.#live(sessionId)) this.#hold(sessionId, session);
        callback();
    }

    get(sessionId: string, callback: (error: unknown, session?: Session | null) => void): void {
        callback(null, this.#live(sessionId) ? (this.#held.get(sessionId)?.session ?? null) : null);
    }

    destroy(sessionId: string, callback: (error?: unknown) => void): void {
        this.#held.delete(sessionId);
        callback();
    }

    async destroyFor(player: PlayerId): Promise<void> {
        for (const [sessionId, held] of this.#held) {
            if (held.session.playerId === player) this.#held.delete(sessionId);
        }
    }

    async prune(): Promise<void> {
        this.#evict();
    }

    #live(sessionId: string): boolean {
        const held = this.#held.get(sessionId);
        if (held === undefined) return false;
        if (held.expiresAt > Date.now()) return true;
        this.#held.delete(sessionId);
        return false;
    }

    #hold(sessionId: string, session: Session): void {
        this.#held.delete(sessionId);
        this.#held.set(sessionId, { session, expiresAt: Date.now() + this.#ttlMs });
        this.#evict();
    }

    #evict(): void {
        const now = Date.now();
        for (const [sessionId, held] of this.#held) {
            if (held.expiresAt > now && this.#held.size <= this.#cap) return;
            this.#held.delete(sessionId);
        }
    }
}
