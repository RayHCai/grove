// A game's files over HTTP: who may read them, what a save changes, what happens to an asset the
// editor claimed and never uploaded, and what the manifest freezing a revision is written from.

import { describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import {
    GameId,
    PlayerId,
    VersionId,
    type Manifest,
    type WorkspaceFile,
} from '@grove/api-contract';
import { buildApp } from '../src/app.js';
import { readEnv } from '../src/env.js';
import { unattachedQueue } from '../src/queue.js';
import { unattachedRecords } from '../src/records.js';
import type { Records, SavePlan, WorkspaceRecord } from '../src/records.js';
import type { Storage, StoredVersion } from '../src/storage.js';

const CREATOR = PlayerId.parse('f47ac10b-58cc-4372-a567-0e02b2c3d479');
const GAME_ID = GameId.parse('9f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f');
const OTHER_GAME_ID = GameId.parse('2b6d4f8a-1c3e-4d5f-9a7b-6c8d0e2f4a1b');
const CREDENTIALS = { email: 'creator@grove.example', password: 'correct horse' };

const SOURCE = 'export const pip = { height: 1 };\n';

const MAIN: WorkspaceFile = {
    path: 'main.ts',
    kind: 'source',
    versionId: VersionId.parse('v1'),
    byteLength: Buffer.byteLength(SOURCE),
    contentType: 'text/typescript',
};

const env = readEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'a'.repeat(32),
    GAME_TOKEN_SECRET: 'b'.repeat(32),
    FLEET_SECRET: 'c'.repeat(32),
    TRUSTED_PROXIES: 'loopback',
    GAMES_CDN_URL: 'https://cdn.grove.example',
    PLATFORM_ORIGIN: 'https://grove.example',
    EDITOR_ORIGIN: 'https://editor.grove.example',
    SERVER_MANAGER_URL: 'http://server-manager.grove.internal:4003',
});

/**
 * One game, owned by the signed-in creator, whose file set is whatever was last saved here.
 *
 * The save is reconciled the way the real one is — upserts applied over the set, deletes removed —
 * and `freeze` is called before it commits, because that ordering is what the routes rely on.
 */
function store(initial: WorkspaceFile[] = [], revision = initial.length === 0 ? 0 : 1): Records {
    let workspace: WorkspaceRecord = {
        gameId: GAME_ID,
        revision,
        files: initial,
        updatedAt: '2026-09-16T09:00:00.000Z',
    };
    return {
        ...unattachedRecords,
        signIn: async (email, password) =>
            email === CREDENTIALS.email && password === CREDENTIALS.password ? CREATOR : undefined,
        ownerOf: async (game) => (game === GAME_ID ? CREATOR : undefined),
        workspaceOf: async (game) => (game === GAME_ID ? workspace : undefined),
        fileOf: async (game, path) =>
            game === GAME_ID ? workspace.files.find((file) => file.path === path) : undefined,
        saveWorkspace: async (_game, plan: SavePlan) => {
            if (plan.baseRevision !== workspace.revision) {
                return { outcome: 'stale', workspace };
            }
            const kept = workspace.files.filter(
                (file) =>
                    !plan.deletes.includes(file.path) &&
                    !plan.upserts.some((upsert) => upsert.path === file.path),
            );
            const files = [...kept, ...plan.upserts].toSorted((left, right) =>
                left.path < right.path ? -1 : 1,
            );
            const next = { ...workspace, revision: workspace.revision + 1, files };
            if (!(await plan.freeze(next.revision, files))) return { outcome: 'unfrozen' };
            workspace = next;
            return { outcome: 'saved', workspace, tasks: [] };
        },
    };
}

interface FakeStorage extends Storage {
    /** Every key ever written, with the exact bytes of each version under it. */
    versions: Map<string, Map<string, { body: Buffer; contentType: string }>>;
    current: Map<string, StoredVersion>;
}

/** A bucket that mints a fresh version per write and remembers every one of them. */
function bucket(): FakeStorage {
    const versions = new Map<string, Map<string, { body: Buffer; contentType: string }>>();
    const current = new Map<string, StoredVersion>();
    let minted = 0;

    const storage: FakeStorage = {
        versions,
        current,
        put: async (key, body, contentType) => {
            minted += 1;
            const versionId = VersionId.parse(`v${String(minted)}`);
            const held = versions.get(key) ?? new Map();
            held.set(versionId, { body, contentType });
            versions.set(key, held);
            const version = { versionId, byteLength: body.byteLength, contentType };
            current.set(key, version);
            return { outcome: 'written', version };
        },
        head: async (key) => current.get(key),
        // No version asked for is whatever is current at the key, which is what the bucket answers.
        get: async (key, versionId) =>
            versions.get(key)?.get(versionId ?? current.get(key)?.versionId ?? ''),
        remove: async (key) => {
            current.delete(key);
        },
        presignPut: async (key) => ({
            outcome: 'signed',
            url: `https://games.example/${key}?X-Amz-Signature=fake`,
            expiresAt: '2026-09-18T12:15:00.000Z',
        }),
    };
    return storage;
}

/** What one key holds right now, decoded — which for a manifest is the snapshot it froze. */
function readManifest(storage: FakeStorage, key: string): Manifest {
    const version = storage.current.get(key);
    const held =
        version === undefined ? undefined : storage.versions.get(key)?.get(version.versionId);
    if (held === undefined) throw new Error(`nothing at ${key}`);
    return JSON.parse(held.body.toString('utf8')) as Manifest;
}

async function signIn(app: FastifyInstance): Promise<{ cookie: string; csrfToken: string }> {
    const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/sessions',
        payload: CREDENTIALS,
    });
    const cookie = response.cookies.find((candidate) => candidate.name === 'sessionId');
    return { cookie: `sessionId=${cookie?.value ?? ''}`, csrfToken: response.json().csrfToken };
}

/** The service with one game in it, a bucket behind it, and nothing listening for a task. */
async function service(records: Records, storage: Storage = bucket()): Promise<FastifyInstance> {
    return buildApp(env, records, undefined, storage, unattachedQueue);
}

describe('reading a workspace', () => {
    it('is revision zero and no files for a game that has never been saved', async () => {
        const built = await service(store());
        const { cookie } = await signIn(built);
        const response = await built.inject({
            method: 'GET',
            url: `/v1/games/${GAME_ID}/workspace`,
            headers: { cookie },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ revision: 0, files: [] });
    });

    it('is refused for a game the viewer does not own', async () => {
        const built = await service(store());
        const { cookie } = await signIn(built);
        const response = await built.inject({
            method: 'GET',
            url: `/v1/games/${OTHER_GAME_ID}/workspace`,
            headers: { cookie },
        });
        expect(response.statusCode).toBe(403);
    });

    it('is refused for a caller holding no session at all', async () => {
        const built = await service(store());
        const response = await built.inject({
            method: 'GET',
            url: `/v1/games/${GAME_ID}/workspace`,
        });
        expect(response.statusCode).toBe(401);
    });
});

describe('saving a workspace', () => {
    async function save(
        built: FastifyInstance,
        body: object,
        game = GAME_ID,
    ): Promise<LightMyRequestResponse> {
        const { cookie, csrfToken } = await signIn(built);
        return built.inject({
            method: 'PUT',
            url: `/v1/games/${game}/workspace`,
            headers: { cookie, 'x-csrf-token': csrfToken },
            payload: body,
        });
    }

    it('takes the text of a source and stores it under the prefix the game owns', async () => {
        const storage = bucket();
        const built = await service(store(), storage);
        const response = await save(built, {
            baseRevision: 0,
            sources: [{ path: 'main.ts', contentType: 'text/typescript', text: SOURCE }],
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ revision: 1 });
        const key = `${GAME_ID}/source/main.ts`;
        expect(storage.current.get(key)?.byteLength).toBe(Buffer.byteLength(SOURCE));
        expect(response.json().files[0]).toMatchObject({
            path: 'main.ts',
            kind: 'source',
            versionId: storage.current.get(key)?.versionId,
        });
    });

    it('changes nothing it was not asked about, which is what makes a save a delta', async () => {
        const built = await service(store([MAIN]), bucket());
        const response = await save(built, {
            baseRevision: 1,
            sources: [{ path: 'enemy.ts', contentType: 'text/typescript', text: 'export {};' }],
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().files.map((file: WorkspaceFile) => file.path)).toEqual([
            'enemy.ts',
            'main.ts',
        ]);
    });

    it('removes a path the save named as deleted', async () => {
        const built = await service(store([MAIN]), bucket());
        const response = await save(built, { baseRevision: 1, deletes: ['main.ts'] });
        expect(response.statusCode).toBe(200);
        expect(response.json().files).toEqual([]);
    });

    it('freezes the whole set into a manifest named by the revision it produced', async () => {
        const storage = bucket();
        const built = await service(store([MAIN]), storage);
        await save(built, {
            baseRevision: 1,
            sources: [{ path: 'enemy.ts', contentType: 'text/typescript', text: 'export {};' }],
        });

        const manifest = readManifest(storage, `${GAME_ID}/manifests/2.json`);
        expect(manifest.revision).toBe(2);
        // Every path the game holds, not only the one this save touched: a manifest is the set.
        expect(manifest.files.map((file) => file.path)).toEqual(['enemy.ts', 'main.ts']);
    });

    it('reads an asset version back from the bucket rather than from the editor', async () => {
        const storage = bucket();
        const key = `${GAME_ID}/assets/art/tile.png`;
        const bytes = Buffer.from([137, 80, 78, 71]);
        await storage.put(key, bytes, 'image/png');

        const built = await service(store(), storage);
        const response = await save(built, { baseRevision: 0, assets: ['art/tile.png'] });
        expect(response.statusCode).toBe(200);
        expect(response.json().files[0]).toMatchObject({
            path: 'art/tile.png',
            kind: 'asset',
            byteLength: bytes.byteLength,
            contentType: 'image/png',
            versionId: storage.current.get(key)?.versionId,
        });
    });

    it('refuses an asset the editor claimed and never uploaded, and names which', async () => {
        const built = await service(store(), bucket());
        const response = await save(built, { baseRevision: 0, assets: ['art/missing.png'] });
        expect(response.statusCode).toBe(400);
        expect(response.json().message).toContain('art/missing.png');
    });

    it('refuses a save taken from a revision that has moved on', async () => {
        const built = await service(store([MAIN]), bucket());
        const response = await save(built, { baseRevision: 0, deletes: [] });
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('conflict');
        expect(response.json().message).toContain('1');
    });

    it('refuses a path that would escape the game it belongs to', async () => {
        const built = await service(store(), bucket());
        const response = await save(built, {
            baseRevision: 0,
            sources: [{ path: '../other/main.ts', contentType: 'text/typescript', text: '' }],
        });
        expect(response.statusCode).toBe(400);
    });

    it('says the seam is empty rather than reporting bytes that went nowhere', async () => {
        const built = await buildApp(env, store(), undefined, undefined, unattachedQueue);
        const response = await save(built, {
            baseRevision: 0,
            sources: [{ path: 'main.ts', contentType: 'text/typescript', text: SOURCE }],
        });
        expect(response.statusCode).toBe(501);
    });

    it('is refused without the token the sign-in handed out', async () => {
        const built = await service(store(), bucket());
        const { cookie } = await signIn(built);
        const response = await built.inject({
            method: 'PUT',
            url: `/v1/games/${GAME_ID}/workspace`,
            headers: { cookie },
            payload: { baseRevision: 0 },
        });
        expect(response.statusCode).toBe(403);
    });
});

describe('reading one file back', () => {
    it('is fetched at the version the rows name, under the type it was stored with', async () => {
        const storage = bucket();
        await storage.put(`${GAME_ID}/source/main.ts`, Buffer.from(SOURCE), 'text/typescript');
        const built = await service(store([MAIN]), storage);
        const { cookie } = await signIn(built);

        const response = await built.inject({
            method: 'GET',
            url: `/v1/games/${GAME_ID}/files/main.ts`,
            headers: { cookie },
        });
        expect(response.statusCode).toBe(200);
        expect(response.body).toBe(SOURCE);
        expect(response.headers['content-type']).toContain('text/typescript');
    });

    it('is a 404 for a path this game does not hold, however full the bucket is', async () => {
        const storage = bucket();
        await storage.put(`${GAME_ID}/source/secret.ts`, Buffer.from('x'), 'text/typescript');
        const built = await service(store(), storage);
        const { cookie } = await signIn(built);

        const response = await built.inject({
            method: 'GET',
            url: `/v1/games/${GAME_ID}/files/secret.ts`,
            headers: { cookie },
        });
        expect(response.statusCode).toBe(404);
    });

    it('is refused outright for a game the viewer does not own', async () => {
        const built = await service(store([MAIN]), bucket());
        const { cookie } = await signIn(built);
        const response = await built.inject({
            method: 'GET',
            url: `/v1/games/${OTHER_GAME_ID}/files/main.ts`,
            headers: { cookie },
        });
        expect(response.statusCode).toBe(403);
    });
});

describe('asking where an asset goes', () => {
    it('hands back a presigned PUT and records nothing', async () => {
        const storage = bucket();
        const built = await service(store(), storage);
        const { cookie, csrfToken } = await signIn(built);

        const response = await built.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/assets`,
            headers: { cookie, 'x-csrf-token': csrfToken },
            payload: { path: 'art/tile.png', contentType: 'image/png' },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().url).toContain(`${GAME_ID}/assets/art/tile.png`);
        // A presign nobody used leaves no file behind, which is what the save afterwards proves.
        expect(storage.current.size).toBe(0);
    });

    it('says the seam is empty rather than signing a URL for no bucket', async () => {
        const built = await buildApp(env, store(), undefined, undefined, unattachedQueue);
        const { cookie, csrfToken } = await signIn(built);
        const response = await built.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/assets`,
            headers: { cookie, 'x-csrf-token': csrfToken },
            payload: { path: 'art/tile.png', contentType: 'image/png' },
        });
        expect(response.statusCode).toBe(501);
    });
});
