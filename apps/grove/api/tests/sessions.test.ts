// The store behind the session cookie, both ways it is held: only a sign-in inserts, so a
// request in flight when a session is revoked has nothing left to write it back into.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from 'fastify';
import { PlayerId } from '@grove/api-contract';
import { MemorySessions, type Sessions } from '../src/sessions.js';
import { prismaSessions } from '../src/store/index.js';
import { database, type Database } from './pglite.js';

const TTL_MS = 60_000;

function held(playerId: PlayerId, ttlMs = TTL_MS): Session {
    return {
        cookie: { originalMaxAge: ttlMs, expires: new Date(Date.now() + ttlMs) },
        playerId,
    } as Session;
}

function read(sessions: Sessions, id: string): Promise<Session | null | undefined> {
    return new Promise((resolve, reject) => {
        sessions.get(id, (error, session) => (error ? reject(error) : resolve(session)));
    });
}

function write(sessions: Sessions, id: string, session: Session): Promise<void> {
    return new Promise((resolve, reject) => {
        sessions.set(id, session, (error) => (error ? reject(error) : resolve()));
    });
}

function destroy(sessions: Sessions, id: string): Promise<void> {
    return new Promise((resolve, reject) => {
        sessions.destroy(id, (error) => (error ? reject(error) : resolve()));
    });
}

let harness: Database;
let one: PlayerId;
let two: PlayerId;

beforeAll(async () => {
    harness = await database();
}, 60_000);

afterAll(async () => {
    await harness?.close();
});

beforeEach(async () => {
    await harness.reset();
    const accounts = await harness.pg.query<{ id: string }>(
        `INSERT INTO "Account" ("email", "displayName", "updatedAt")
         VALUES ('one@grove.example', 'One', now()), ('two@grove.example', 'Two', now())
         RETURNING "id"`,
    );
    one = PlayerId.parse(accounts.rows[0]?.id);
    two = PlayerId.parse(accounts.rows[1]?.id);
});

describe.each([
    ['in Postgres', () => prismaSessions(harness.db, TTL_MS)],
    ['in this process', () => new MemorySessions(TTL_MS)],
])('a session store %s', (_where, make) => {
    it('holds what a sign-in opened, and what each request after it writes', async () => {
        const sessions = make();
        await sessions.open('sid-1', held(one));
        expect(await read(sessions, 'sid-1')).toMatchObject({ playerId: one });

        await write(sessions, 'sid-1', { ...held(one), _csrf: 'secret' } as Session);
        expect(await read(sessions, 'sid-1')).toMatchObject({ _csrf: 'secret' });
    });

    it('never creates a session from a write, which is what makes revoking one stick', async () => {
        const sessions = make();
        await write(sessions, 'sid-never-opened', held(one));
        expect(await read(sessions, 'sid-never-opened')).toBeNull();

        await sessions.open('sid-1', held(one));
        await destroy(sessions, 'sid-1');
        // The rolling save of a request that loaded the session before it was revoked.
        await write(sessions, 'sid-1', held(one));
        expect(await read(sessions, 'sid-1')).toBeNull();
    });

    it("revokes every session one account holds, and nobody else's", async () => {
        const sessions = make();
        await sessions.open('mine-1', held(one));
        await sessions.open('mine-2', held(one));
        await sessions.open('theirs', held(two));

        await sessions.destroyFor(one);
        expect(await read(sessions, 'mine-1')).toBeNull();
        expect(await read(sessions, 'mine-2')).toBeNull();
        expect(await read(sessions, 'theirs')).toMatchObject({ playerId: two });
    });
});

describe('a session store in Postgres', () => {
    it('keeps the digest of an id and never the id, so a read of the table opens nothing', async () => {
        await prismaSessions(harness.db, TTL_MS).open('sid-secret', held(one));
        const rows = await harness.pg.query<{ idHash: Uint8Array }>(
            'SELECT "idHash" FROM "Session"',
        );
        expect(rows.rows[0]?.idHash).toHaveLength(32);
        expect(Buffer.from(rows.rows[0]?.idHash ?? []).toString('utf8')).not.toContain(
            'sid-secret',
        );
    });

    it('refuses a session past its expiry, and prunes it', async () => {
        const sessions = prismaSessions(harness.db, TTL_MS);
        await sessions.open('sid-1', held(one));
        await harness.pg.query(`UPDATE "Session" SET "expiresAt" = now() - interval '1 second'`);
        expect(await read(sessions, 'sid-1')).toBeNull();

        await sessions.prune();
        expect((await harness.pg.query('SELECT 1 FROM "Session"')).rows).toHaveLength(0);
    });

    it('answers on another replica, which is what a deploy that signs nobody out needs', async () => {
        await prismaSessions(harness.db, TTL_MS).open('sid-1', held(one));
        expect(await read(prismaSessions(harness.db, TTL_MS), 'sid-1')).toMatchObject({
            playerId: one,
        });
    });

    it('goes with the account when the account goes', async () => {
        await prismaSessions(harness.db, TTL_MS).open('sid-1', held(one));
        await harness.pg.query(`DELETE FROM "Account" WHERE "id" = $1`, [one]);
        expect((await harness.pg.query('SELECT 1 FROM "Session"')).rows).toHaveLength(0);
    });
});

describe('a session store in this process', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('forgets a session that outlived the cookie naming it, and keeps one in use', async () => {
        const sessions = new MemorySessions(1_000);
        await sessions.open('idle', held(one, 1_000));
        await sessions.open('busy', held(one, 1_000));
        vi.advanceTimersByTime(900);
        await write(sessions, 'busy', held(one, 1_000));
        vi.advanceTimersByTime(200);
        expect(await read(sessions, 'idle')).toBeNull();
        expect(await read(sessions, 'busy')).not.toBeNull();
    });

    it('drops the oldest rather than growing past its ceiling', async () => {
        const sessions = new MemorySessions(1_000, 2);
        await sessions.open('first', held(one));
        await sessions.open('second', held(one));
        await sessions.open('third', held(one));
        expect(await read(sessions, 'first')).toBeNull();
        expect(await read(sessions, 'third')).not.toBeNull();
    });
});
