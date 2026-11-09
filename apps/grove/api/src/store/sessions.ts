import type { Session } from 'fastify';
import { expiryOf, type Sessions } from '../sessions.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { digest } from './shared.js';

type Done = (error?: unknown) => void;

/** A session as a JSON value: the cookie's own `toJSON` and the keys the plugins wrote. */
function plain(session: Session): object {
    return JSON.parse(JSON.stringify(session)) as object;
}

/** Sessions in Postgres, so every replica answers every cookie and a deploy signs nobody out. */
export function prismaSessions(db: PrismaClient, ttlMs: number): Sessions {
    return {
        open: async (sessionId, session) => {
            const playerId = session.playerId;
            if (playerId === undefined) throw new Error('a session is opened for an account');
            await db.session.create({
                data: {
                    idHash: digest(sessionId),
                    playerId,
                    data: plain(session),
                    expiresAt: expiryOf(session, ttlMs),
                },
            });
        },

        set: (sessionId: string, session: Session, done: Done) => {
            // An update and never an insert, so a revoked session cannot be written back.
            db.session
                .updateMany({
                    where: { idHash: digest(sessionId), expiresAt: { gt: new Date() } },
                    data: { data: plain(session), expiresAt: expiryOf(session, ttlMs) },
                })
                .then(() => done(), done);
        },

        get: (sessionId: string, done: (error: unknown, session?: Session | null) => void) => {
            db.session
                .findFirst({
                    where: { idHash: digest(sessionId), expiresAt: { gt: new Date() } },
                    select: { data: true },
                })
                .then(
                    (row) => done(null, row === null ? null : (row.data as unknown as Session)),
                    done,
                );
        },

        destroy: (sessionId: string, done: Done) => {
            db.session
                .deleteMany({ where: { idHash: digest(sessionId) } })
                .then(() => done(), done);
        },

        destroyFor: async (player) => {
            await db.session.deleteMany({ where: { playerId: player } });
        },

        prune: async () => {
            await db.session.deleteMany({ where: { expiresAt: { lte: new Date() } } });
        },
    };
}
