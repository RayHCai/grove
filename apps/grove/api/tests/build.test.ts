// What a build box may read and what it may write, which is the whole of the credential it holds:
// one frozen manifest's files, at the versions that manifest named, and the prefix its own
// revision owns.

import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
    BuildArtifact,
    VersionId,
    encodeManifest,
    manifestKey,
    objectKey,
    type WorkspaceFile,
    type WorkspacePath,
} from '@grove/api-contract';
import { buildApp } from '../src/app.js';
import { CDN, FLEET_SECRET, GAME_ID, OTHER_GAME_ID, testEnv } from './fixtures.js';
import { unattachedRecords } from '../src/records.js';
import { StorageUnavailable, type Storage, type StoredObject } from '../src/storage.js';

const REVISION = 4;

const env = testEnv({ TRUSTED_PROXIES: '10.0.0.9' });

const bearer = { authorization: `Bearer ${FLEET_SECRET}` };

/** The version the manifest froze, and a second one written over it since. */
const FROZEN = VersionId.parse('v1');
const CURRENT = VersionId.parse('v2');

const SOURCE: WorkspaceFile = {
    path: 'src/player.ts' as WorkspacePath,
    kind: 'source',
    versionId: FROZEN,
    byteLength: 12,
    contentType: 'text/typescript',
};

interface FakeStorage extends Storage {
    written: Map<string, { body: Buffer; contentType: string }>;
}

/**
 * A bucket holding one frozen manifest and two versions of the file it names.
 *
 * Two versions on purpose: what a build reads has to be the one the manifest pinned, and a bucket
 * that answered with whatever is current would let an edit made after the publish reach a compiler.
 */
function bucket(): FakeStorage {
    const written = new Map<string, { body: Buffer; contentType: string }>();
    const key = objectKey(GAME_ID, 'source', SOURCE.path);
    const held = new Map<string, StoredObject>([
        [
            `${manifestKey(GAME_ID, REVISION)}@`,
            {
                body: Buffer.from(
                    encodeManifest({ gameId: GAME_ID, revision: REVISION, files: [SOURCE] }),
                    'utf8',
                ),
                contentType: 'application/json',
            },
        ],
        [`${key}@${FROZEN}`, { body: Buffer.from('the frozen'), contentType: 'text/typescript' }],
        [`${key}@${CURRENT}`, { body: Buffer.from('typed since'), contentType: 'text/typescript' }],
    ]);

    return {
        written,
        put: async (target, body, contentType) => {
            written.set(target, { body, contentType });
            return {
                outcome: 'written',
                version: { versionId: CURRENT, byteLength: body.byteLength, contentType },
            };
        },
        head: async () => undefined,
        get: async (target, versionId) => held.get(`${target}@${versionId ?? ''}`),
        remove: async () => undefined,
        erase: async () => ({ outcome: 'erased' }),
        presignPut: async () => ({ outcome: 'unattached' }),
    };
}

async function serving(storage: Storage = bucket()): Promise<FastifyInstance> {
    return buildApp(env, unattachedRecords, undefined, storage);
}

describe('the source a build is handed', () => {
    it('is the manifest the revision froze', async () => {
        const app = await serving();
        const response = await app.inject({
            method: 'GET',
            url: `/v1/fleet/games/${GAME_ID}/revisions/${REVISION}/manifest`,
            headers: bearer,
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ gameId: GAME_ID, revision: REVISION });
    });

    it('is the version that manifest named, never what the key holds now', async () => {
        const app = await serving();
        const response = await app.inject({
            method: 'GET',
            url: `/v1/fleet/games/${GAME_ID}/revisions/${REVISION}/files/${SOURCE.path}`,
            headers: bearer,
        });

        expect(response.statusCode).toBe(200);
        expect(response.body).toBe('the frozen');
    });

    it('is nothing at all for a file that revision does not name', async () => {
        const app = await serving();
        const response = await app.inject({
            method: 'GET',
            url: `/v1/fleet/games/${GAME_ID}/revisions/${REVISION}/files/src/secrets.ts`,
            headers: bearer,
        });
        expect(response.statusCode).toBe(404);
    });

    it('is nothing at all for a revision nothing froze', async () => {
        const app = await serving();
        const response = await app.inject({
            method: 'GET',
            url: `/v1/fleet/games/${OTHER_GAME_ID}/revisions/${REVISION}/manifest`,
            headers: bearer,
        });
        expect(response.statusCode).toBe(404);
    });

    it('is refused without the fleet bearer, which is the only thing standing in front of it', async () => {
        const app = await serving();
        const response = await app.inject({
            method: 'GET',
            url: `/v1/fleet/games/${GAME_ID}/revisions/${REVISION}/manifest`,
        });
        expect(response.statusCode).toBe(401);
    });
});

describe('what a build writes', () => {
    it('lands under the prefix its own revision owns, and is answered for by address', async () => {
        const storage = bucket();
        const app = await serving(storage);

        const response = await app.inject({
            method: 'PUT',
            url: `/v1/fleet/games/${GAME_ID}/revisions/${REVISION}/build/client.js`,
            headers: { ...bearer, 'content-type': 'text/javascript' },
            payload: 'export const side = "client";',
        });

        expect(response.statusCode).toBe(200);
        const artifact = BuildArtifact.parse(response.json());
        expect(artifact.url).toBe(`${CDN}/${GAME_ID}/build/${REVISION}/client.js`);
        // Hashed where the bytes landed, because a handshake compares this against a digest of
        // what a browser fetched.
        expect(artifact.hash).toMatch(/^[0-9a-f]{64}$/u);
        expect(storage.written.has(`${GAME_ID}/build/${REVISION}/client.js`)).toBe(true);
    });

    it('is stored as the bytes it arrived as, JSON included', async () => {
        const storage = bucket();
        const app = await serving(storage);
        const body = '{"simRate":30}';

        await app.inject({
            method: 'PUT',
            url: `/v1/fleet/games/${GAME_ID}/revisions/${REVISION}/build/simConfig.json`,
            headers: { ...bearer, 'content-type': 'application/json' },
            payload: body,
        });

        // Byte for byte: a body parsed and re-serialised here would be stored under a hash that
        // is not the one it was written as.
        const stored = storage.written.get(`${GAME_ID}/build/${REVISION}/simConfig.json`);
        expect(stored?.body.toString('utf8')).toBe(body);
        expect(stored?.contentType).toBe('application/json');
    });

    it('may not name a path, which is how it would reach outside its own revision', async () => {
        const app = await serving();
        const response = await app.inject({
            method: 'PUT',
            url: `/v1/fleet/games/${GAME_ID}/revisions/${REVISION}/build/..%2F..%2Fsource%2Fmain.ts`,
            headers: { ...bearer, 'content-type': 'text/javascript' },
            payload: 'anything',
        });
        expect(response.statusCode).toBe(400);
    });
});

describe('a bucket that does not answer', () => {
    /** Holds the manifest, then fails every read past it the way S3 does when it is down. */
    function failing(): Storage {
        const held = bucket();
        return {
            ...held,
            get: async (key, versionId) => {
                if (key === manifestKey(GAME_ID, REVISION)) return held.get(key, versionId);
                throw new StorageUnavailable(key);
            },
        };
    }

    it('is a 503 on the manifest, so a builder retries rather than failing the build', async () => {
        const app = await serving({
            ...bucket(),
            get: async (key) => {
                throw new StorageUnavailable(key);
            },
        });
        const response = await app.inject({
            method: 'GET',
            url: `/v1/fleet/games/${GAME_ID}/revisions/${REVISION}/manifest`,
            headers: bearer,
        });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({ code: 'internal' });
    });

    it('is a 503 on a file the manifest names, never the 404 a missing file earns', async () => {
        const app = await serving(failing());
        const response = await app.inject({
            method: 'GET',
            url: `/v1/fleet/games/${GAME_ID}/revisions/${REVISION}/files/${SOURCE.path}`,
            headers: bearer,
        });
        expect(response.statusCode).toBe(503);
    });
});

describe('the fleet routes', () => {
    it('sit outside the browser rate limit, which a creator route still carries', async () => {
        const app = await serving();
        const fleet = await app.inject({
            method: 'GET',
            url: `/v1/fleet/games/${GAME_ID}/revisions/${REVISION}/manifest`,
            headers: bearer,
        });
        const browser = await app.inject({ method: 'POST', url: '/v1/auth/sessions', payload: {} });

        expect(fleet.headers['x-ratelimit-limit']).toBeUndefined();
        expect(browser.headers['x-ratelimit-limit']).toBeDefined();
    });
});
