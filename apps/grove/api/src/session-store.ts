import type { Session } from 'fastify';
import type { SessionStore } from '@fastify/session';

/** What one process should hold at once, and few enough that a flood cannot exhaust its heap. */
const MAX_LIVE_SESSIONS = 50_000;

/**
 * Sessions held for one process, dropped once they outlive the cookie that names them.
 *
 * The plugin's own store is a `Map` with no expiry and no ceiling, so a public service grows by an
 * entry per caller and never shrinks. Entries leave oldest-first, which is also expiry order
 * because every write re-inserts.
 */
export class ExpiringSessionStore implements SessionStore {
    readonly #ttlMs: number;
    readonly #cap: number;
    readonly #held = new Map<string, { session: Session; expiresAt: number }>();

    constructor(ttlMs: number, cap: number = MAX_LIVE_SESSIONS) {
        this.#ttlMs = ttlMs;
        this.#cap = cap;
    }

    set(sessionId: string, session: Session, callback: (error?: unknown) => void): void {
        this.#held.delete(sessionId);
        this.#held.set(sessionId, { session, expiresAt: Date.now() + this.#ttlMs });
        this.#evict();
        callback();
    }

    get(sessionId: string, callback: (error: unknown, session?: Session | null) => void): void {
        const held = this.#held.get(sessionId);
        if (held === undefined || held.expiresAt <= Date.now()) {
            this.#held.delete(sessionId);
            callback(null, null);
            return;
        }
        callback(null, held.session);
    }

    destroy(sessionId: string, callback: (error?: unknown) => void): void {
        this.#held.delete(sessionId);
        callback();
    }

    #evict(): void {
        const now = Date.now();
        for (const [sessionId, held] of this.#held) {
            if (held.expiresAt > now && this.#held.size <= this.#cap) return;
            this.#held.delete(sessionId);
        }
    }
}
