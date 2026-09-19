import type { Session } from 'fastify';
import type { SessionStore } from '@fastify/session';

/** What one process should hold at once, and few enough that a flood cannot exhaust its heap. */
const MAX_LIVE_SESSIONS = 50_000;

/**
 * Sessions held for one process, dropped once they outlive the cookie that names them.
 * Entries leave oldest-first, which is also expiry order because every write re-inserts.
 */
export class ExpiringSessionStore implements SessionStore {
    readonly #ttlMs: number;
    readonly #cap: number;
    readonly #held = new Map<string, { session: Session; expiresAt: number }>();
    /**
     * Ids that were revoked, and until when. With `rolling` on, a request already in flight saves
     * its session from the object it loaded BEFORE the revocation, restoring what a sign-out ended.
     */
    readonly #revoked = new Map<string, number>();

    constructor(ttlMs: number, cap: number = MAX_LIVE_SESSIONS) {
        this.#ttlMs = ttlMs;
        this.#cap = cap;
    }

    set(sessionId: string, session: Session, callback: (error?: unknown) => void): void {
        if (this.#isRevoked(sessionId)) {
            callback();
            return;
        }
        this.#held.delete(sessionId);
        this.#held.set(sessionId, { session, expiresAt: Date.now() + this.#ttlMs });
        this.#evict();
        callback();
    }

    get(sessionId: string, callback: (error: unknown, session?: Session | null) => void): void {
        const held = this.#held.get(sessionId);
        if (held === undefined || held.expiresAt <= Date.now() || this.#isRevoked(sessionId)) {
            this.#held.delete(sessionId);
            callback(null, null);
            return;
        }
        callback(null, held.session);
    }

    destroy(sessionId: string, callback: (error?: unknown) => void): void {
        this.#revoke(sessionId);
        callback();
    }

    /**
     * Drops every session an account holds, which is what a password change is for.
     * The caller's own is among them, so a route keeping them signed in must mint a fresh one.
     */
    destroyFor(playerId: string): void {
        for (const [sessionId, held] of this.#held) {
            if (held.session.playerId === playerId) this.#revoke(sessionId);
        }
    }

    #revoke(sessionId: string): void {
        this.#held.delete(sessionId);
        // Held only as long as the cookie could still be presented; past that the TTL refuses it
        // anyway and the tombstone would be a second leak beside the one this class exists to fix.
        // Re-inserted rather than updated in place, so insertion order stays expiry order.
        this.#revoked.delete(sessionId);
        this.#revoked.set(sessionId, Date.now() + this.#ttlMs);
        this.#forgetStaleRevocations();
    }

    #isRevoked(sessionId: string): boolean {
        const until = this.#revoked.get(sessionId);
        if (until === undefined) return false;
        if (until > Date.now()) return true;
        this.#revoked.delete(sessionId);
        return false;
    }

    #forgetStaleRevocations(): void {
        const now = Date.now();
        for (const [sessionId, until] of this.#revoked) {
            // Insertion order is expiry order, so the first live one ends the sweep.
            if (until > now && this.#revoked.size <= this.#cap) return;
            this.#revoked.delete(sessionId);
        }
    }

    #evict(): void {
        const now = Date.now();
        for (const [sessionId, held] of this.#held) {
            if (held.expiresAt > now && this.#held.size <= this.#cap) return;
            this.#held.delete(sessionId);
        }
    }
}
