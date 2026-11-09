// What a build box may read and write over HTTP, which is the whole of what its secret buys: the
// manifest and sources of the build it claimed, and outputs under that build's own prefix.

import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
    BuildArtifact,
    VersionId,
    encodeManifest,
    manifestKey,
    objectKey,
    type TaskId,
    type WorkspaceFile,
    type WorkspacePath,
} from '@grove/api-contract';
import { buildApp } from '../src/app.js';
import type { BuildWork } from '../src/records.js';
import { StorageUnavailable, type Storage } from '../src/storage.js';
import { bucket, stores, type Bucket } from './doubles.js';
import {
    ASSET_SERVICE_SECRET,
    BUILDER_SECRET,
    CDN,
    GAME_ID,
    OTHER_GAME_ID,
    TASK_ID,
    bearer,
    testEnv,
} from './fixtures.js';

const REVISION = 4;
const SAVE = '0b3f8a5e-2c4d-4f7a-9b1e-6d5c4a3b2e10';
const env = testEnv({ TRUSTED_PROXIES: '10.0.0.9' });
const builder = bearer(BUILDER_SECRET);

const SOURCE: WorkspaceFile = {
    path: 'src/player.ts' as WorkspacePath,
    kind: 'source',
    versionId: VersionId.parse('v1'),
    byteLength: 10,
    contentType: 'text/typescript',
};

/** A bucket holding one frozen manifest and two versions of the file it names. */
async function frozen(): Promise<{ storage: Bucket; frozenVersion: VersionId }> {
    const storage = bucket();
    const key = objectKey(GAME_ID, 'source', SOURCE.path);
    const first = await storage.put(key, Buffer.from('the frozen'), 'text/typescript');
    await storage.put(key, Buffer.from('typed since'), 'text/typescript');
    if (first.outcome !== 'written') throw new Error(first.outcome);
    const files = [{ ...SOURCE, versionId: first.version.versionId }];
    await storage.put(
        manifestKey(GAME_ID, REVISION, SAVE),
        Buffer.from(encodeManifest({ gameId: GAME_ID, revision: REVISION, files })),
        'application/json',
    );
    return { storage, frozenVersion: first.version.versionId };
}

function serving(
    storage: Storage,
    live = true,
    recorded: BuildArtifact[] = [],
): Promise<FastifyInstance> {
    const work: BuildWork = {
        taskId: TASK_ID,
        gameId: GAME_ID,
        revision: REVISION,
        saveId: SAVE,
        live,
    };
    return buildApp(env, {
        ...stores({
            tasks: {
                buildOf: async (task: TaskId) => (task === TASK_ID ? work : undefined),
                recordArtifact: async (_task, artifact) => {
                    recorded.push(artifact);
                },
            },
        }),
        storage,
    });
}

describe('the source a build is handed', () => {
    it('is the manifest its save froze, and the version that manifest named', async () => {
        const { storage } = await frozen();
        const app = await serving(storage);
        const manifest = await app.inject({
            method: 'GET',
            url: `/v1/fleet/tasks/${TASK_ID}/manifest`,
            headers: builder,
        });
        expect(manifest.json()).toMatchObject({ gameId: GAME_ID, revision: REVISION });

        const file = await app.inject({
            method: 'GET',
            url: `/v1/fleet/tasks/${TASK_ID}/files/${SOURCE.path}`,
            headers: builder,
        });
        expect(file.statusCode).toBe(200);
        expect(file.body).toBe('the frozen');
    });

    it('is nothing for a path that manifest does not name, or a task that is no build', async () => {
        const { storage } = await frozen();
        const app = await serving(storage);
        const absent = await app.inject({
            method: 'GET',
            url: `/v1/fleet/tasks/${TASK_ID}/files/src/secrets.ts`,
            headers: builder,
        });
        expect(absent.statusCode).toBe(404);
        const stranger = await app.inject({
            method: 'GET',
            url: `/v1/fleet/tasks/${OTHER_GAME_ID}/manifest`,
            headers: builder,
        });
        expect(stranger.statusCode).toBe(404);
    });

    it('is refused for a build nobody holds, whose source is no worker business', async () => {
        const { storage } = await frozen();
        const app = await serving(storage, false);
        const response = await app.inject({
            method: 'GET',
            url: `/v1/fleet/tasks/${TASK_ID}/manifest`,
            headers: builder,
        });
        expect(response.statusCode).toBe(409);
    });

    it("is refused to any secret but the builder's", async () => {
        const { storage } = await frozen();
        const app = await serving(storage);
        for (const headers of [{}, bearer(ASSET_SERVICE_SECRET)]) {
            const response = await app.inject({
                method: 'GET',
                url: `/v1/fleet/tasks/${TASK_ID}/manifest`,
                headers,
            });
            expect(response.statusCode).toBe(401);
        }
    });
});

describe('what a build writes', () => {
    it('lands under its own digest beneath the task, and is answered for by address', async () => {
        const recorded: BuildArtifact[] = [];
        const storage = bucket();
        const app = await serving(storage, true, recorded);
        const response = await app.inject({
            method: 'PUT',
            url: `/v1/fleet/tasks/${TASK_ID}/build/client.js`,
            headers: { ...builder, 'content-type': 'text/html' },
            payload: 'export const side = "client";',
        });
        expect(response.statusCode).toBe(200);
        const artifact = BuildArtifact.parse(response.json());
        expect(artifact.url).toBe(`${CDN}/${GAME_ID}/build/${TASK_ID}/${artifact.hash}/client.js`);
        expect(recorded).toEqual([artifact]);
        // The type is the name's, never the one the worker sent, so the edge serves no page.
        expect(storage.current(artifact.url.slice(CDN.length + 1))?.contentType).toBe(
            'text/javascript',
        );
    });

    it('is stored as the bytes it arrived as, JSON included', async () => {
        const storage = bucket();
        const app = await serving(storage);
        const body = '{"simRate":30}';
        const response = await app.inject({
            method: 'PUT',
            url: `/v1/fleet/tasks/${TASK_ID}/build/simConfig.json`,
            headers: { ...builder, 'content-type': 'application/json' },
            payload: body,
        });
        const key = BuildArtifact.parse(response.json()).url.slice(CDN.length + 1);
        expect(storage.current(key)?.body.toString('utf8')).toBe(body);
    });

    it('may not name a path, which is how it would reach outside its own build', async () => {
        const app = await serving(bucket());
        const response = await app.inject({
            method: 'PUT',
            url: `/v1/fleet/tasks/${TASK_ID}/build/..%2F..%2Fsource%2Fmain.ts`,
            headers: { ...builder, 'content-type': 'text/javascript' },
            payload: 'anything',
        });
        expect(response.statusCode).toBe(400);
    });
});

describe('a bucket that does not answer', () => {
    it('is a 503, never a 404, so a builder retries rather than failing the build', async () => {
        const { storage } = await frozen();
        const failing: Storage = {
            ...storage,
            get: async (key) => {
                throw new StorageUnavailable(key);
            },
        };
        const app = await serving(failing);
        const response = await app.inject({
            method: 'GET',
            url: `/v1/fleet/tasks/${TASK_ID}/manifest`,
            headers: builder,
        });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({ code: 'internal' });
    });
});

describe('the fleet routes', () => {
    it('sit outside the browser rate limit, which a creator route still carries', async () => {
        const { storage } = await frozen();
        const app = await serving(storage);
        const fleet = await app.inject({
            method: 'GET',
            url: `/v1/fleet/tasks/${TASK_ID}/manifest`,
            headers: builder,
        });
        const browser = await app.inject({ method: 'POST', url: '/v1/auth/sessions', payload: {} });
        expect(fleet.headers['x-ratelimit-limit']).toBeUndefined();
        expect(browser.headers['x-ratelimit-limit']).toBeDefined();
    });
});
