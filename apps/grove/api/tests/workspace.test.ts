// A game's files over HTTP against a real Postgres and a bucket that refuses what S3 would: who may
// read them, what a save answers, and what an upload request is signed for.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { MAX_ASSET_BYTES, type GameId, type WorkspaceFile } from '@grove/api-contract';
import { SESSION_TTL_MS, buildApp } from '../src/app.js';
import type { Stores } from '../src/records.js';
import { prismaSessions, prismaStores } from '../src/store/index.js';
import { announcing, bucket, type Bucket } from './doubles.js';
import { OTHER_GAME_ID, signIn, testEnv, type Credentials } from './fixtures.js';
import { database, type Database } from './pglite.js';

const env = testEnv();
const LOGIN = { email: 'creator@grove.example', password: 'a long enough password' };
const SOURCE = 'export const pip = { height: 1 };\n';

let harness: Database;
let stores: Stores;

beforeAll(async () => {
    harness = await database();
    stores = prismaStores(harness.db);
}, 60_000);

afterAll(async () => {
    await harness?.close();
});

interface Served {
    app: FastifyInstance;
    storage: Bucket;
    gameId: GameId;
    who: Credentials;
}

let served: Served;

beforeEach(async () => {
    await harness.reset();
    const created = await stores.accounts.createAccount(LOGIN.email, LOGIN.password, 'Creator');
    if (created.outcome !== 'created') throw new Error(created.outcome);
    const game = await stores.games.createGame(created.account.playerId, 'My Game');
    if (game.outcome !== 'created') throw new Error(game.outcome);
    const storage = bucket();
    const app = await replica(storage);
    served = { app, storage, gameId: game.game.gameId, who: await signIn(app, LOGIN) };
});

/** One process of the service over the shared database, as each replica behind a balancer is. */
function replica(storage: Bucket): Promise<FastifyInstance> {
    return buildApp(env, {
        ...stores,
        sessions: prismaSessions(harness.db, SESSION_TTL_MS),
        storage,
        queue: announcing(),
    });
}

describe('a session held in Postgres', () => {
    it('answers on another replica, and a sign-out on one ends it on both', async () => {
        const other = await replica(served.storage);
        const read = await other.inject({
            method: 'GET',
            url: `/v1/games/${served.gameId}/workspace`,
            headers: { cookie: served.who.cookie },
        });
        expect(read.statusCode).toBe(200);

        const out = await other.inject({
            method: 'DELETE',
            url: '/v1/auth/sessions/current',
            headers: { cookie: served.who.cookie, 'x-csrf-token': served.who.csrfToken },
        });
        expect(out.statusCode).toBe(204);
        const after = await served.app.inject({
            method: 'GET',
            url: `/v1/games/${served.gameId}/workspace`,
            headers: { cookie: served.who.cookie },
        });
        expect(after.statusCode).toBe(401);
    });
});

function save(body: object, game: GameId = served.gameId): Promise<LightMyRequestResponse> {
    return served.app.inject({
        method: 'PUT',
        url: `/v1/games/${game}/workspace`,
        headers: { cookie: served.who.cookie, 'x-csrf-token': served.who.csrfToken },
        payload: body,
    });
}

function ask(body: object): Promise<LightMyRequestResponse> {
    return served.app.inject({
        method: 'POST',
        url: `/v1/games/${served.gameId}/assets`,
        headers: { cookie: served.who.cookie, 'x-csrf-token': served.who.csrfToken },
        payload: body,
    });
}

const main = { path: 'main.ts', contentType: 'text/typescript', text: SOURCE };

describe('reading a workspace', () => {
    it('is revision zero and no files for a game nobody has saved, with no save id on the wire', async () => {
        const response = await served.app.inject({
            method: 'GET',
            url: `/v1/games/${served.gameId}/workspace`,
            headers: { cookie: served.who.cookie },
        });
        expect(response.json()).toEqual({
            gameId: served.gameId,
            revision: 0,
            files: [],
            updatedAt: expect.any(String),
        });
    });

    it('is refused for a game the viewer does not own, and for a caller holding no session', async () => {
        const theirs = await served.app.inject({
            method: 'GET',
            url: `/v1/games/${OTHER_GAME_ID}/workspace`,
            headers: { cookie: served.who.cookie },
        });
        expect(theirs.statusCode).toBe(403);
        const nobody = await served.app.inject({
            method: 'GET',
            url: `/v1/games/${served.gameId}/workspace`,
        });
        expect(nobody.statusCode).toBe(401);
    });
});

describe('saving a workspace', () => {
    it('stores a source under the prefix the game owns, and answers the set it froze', async () => {
        const response = await save({ baseRevision: 0, sources: [main] });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ revision: 1 });
        expect(response.json()).not.toHaveProperty('saveId');
        const file = (response.json().files as WorkspaceFile[])[0];
        expect(served.storage.current(`${served.gameId}/source/main.ts`)?.versionId).toBe(
            file?.versionId,
        );
    });

    it('refuses a save from a revision that has moved on, naming the one it is at', async () => {
        await save({ baseRevision: 0, sources: [main] });
        const late = await save({ baseRevision: 0, deletes: ['main.ts'] });
        expect(late.statusCode).toBe(409);
        expect(late.json().message).toContain('revision 1');
    });

    it('refuses an asset the editor claimed and never uploaded, and names which', async () => {
        const response = await save({ baseRevision: 0, assets: ['art/missing.png'] });
        expect(response.statusCode).toBe(400);
        expect(response.json().message).toContain('art/missing.png');
    });

    it('refuses a path that would escape the game, and a write with no token', async () => {
        expect(
            (await save({ baseRevision: 0, sources: [{ ...main, path: '../other/main.ts' }] }))
                .statusCode,
        ).toBe(400);
        const tokenless = await served.app.inject({
            method: 'PUT',
            url: `/v1/games/${served.gameId}/workspace`,
            headers: { cookie: served.who.cookie },
            payload: { baseRevision: 0 },
        });
        expect(tokenless.statusCode).toBe(403);
    });

    it('says the bucket is missing rather than reporting bytes that went nowhere', async () => {
        const unattached = await buildApp(env, {
            ...stores,
            sessions: prismaSessions(harness.db, SESSION_TTL_MS),
            queue: announcing(),
        });
        const who = await signIn(unattached, LOGIN);
        const response = await unattached.inject({
            method: 'PUT',
            url: `/v1/games/${served.gameId}/workspace`,
            headers: { cookie: who.cookie, 'x-csrf-token': who.csrfToken },
            payload: { baseRevision: 0, sources: [main] },
        });
        expect(response.statusCode).toBe(501);
    });
});

describe('reading one file back', () => {
    it('streams it at the version the rows name, under the type it was stored with', async () => {
        await save({ baseRevision: 0, sources: [main] });
        // Written over since, which is a version no row names.
        await served.storage.put(
            `${served.gameId}/source/main.ts`,
            Buffer.from('later'),
            'text/plain',
        );

        const response = await served.app.inject({
            method: 'GET',
            url: `/v1/games/${served.gameId}/files/main.ts`,
            headers: { cookie: served.who.cookie },
        });
        expect(response.statusCode).toBe(200);
        expect(response.body).toBe(SOURCE);
        expect(response.headers['content-type']).toContain('text/typescript');
        expect(response.headers['cache-control']).toBe('private, no-cache');
    });

    it('is a 404 for a path this game does not hold, however full the bucket is', async () => {
        await served.storage.put(
            `${served.gameId}/source/secret.ts`,
            Buffer.from('x'),
            'text/plain',
        );
        const response = await served.app.inject({
            method: 'GET',
            url: `/v1/games/${served.gameId}/files/secret.ts`,
            headers: { cookie: served.who.cookie },
        });
        expect(response.statusCode).toBe(404);
    });
});

describe('asking where an asset goes', () => {
    it('hands back a PUT into quarantine signed for its type and length, recording nothing', async () => {
        const response = await ask({
            path: 'art/tile.png',
            contentType: 'image/png',
            byteLength: 4,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            path: 'art/tile.png',
            maxBytes: MAX_ASSET_BYTES,
            headers: { 'content-type': 'image/png' },
        });
        expect(response.json().url).toContain(`uploads/${served.gameId}/art/tile.png`);
        expect(served.storage.versions.size).toBe(0);
        expect(
            served.storage.send(response.json().url, Buffer.alloc(5), response.json().headers)
                .status,
        ).toBe(403);
    });

    it('refuses a length past the ceiling as too large, and a type the edge would serve as a page', async () => {
        const big = await ask({
            path: 'art/tile.png',
            contentType: 'image/png',
            byteLength: MAX_ASSET_BYTES + 1,
        });
        expect(big.statusCode).toBe(413);
        const page = await ask({ path: 'art/page.html', contentType: 'text/html', byteLength: 4 });
        expect(page.statusCode).toBe(400);
    });
});
