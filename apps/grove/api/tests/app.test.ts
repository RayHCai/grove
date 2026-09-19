import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, Session } from 'fastify';
import {
    GameId,
    PlayerId,
    REQUEST_ID_HEADER,
    REQUEST_ID_MAX_LENGTH,
    SessionId,
    TaskId,
    VersionId,
} from '@grove/api-contract';
import type { PlayableVersion, PublishedVersion, Task, TaskKind } from '@grove/api-contract';
import { verifySessionToken } from '@grove/api-contract/tokens';
import { buildApp } from '../src/app.js';
import { readEnv } from '../src/env.js';
import { unattachedFleet } from '../src/fleet.js';
import type { Fleet } from '../src/fleet.js';
import { unattachedQueue } from '../src/queue.js';
import type { TaskQueue } from '../src/queue.js';
import { unattachedRecords } from '../src/records.js';
import type { Records } from '../src/records.js';
import { ExpiringSessionStore } from '../src/session-store.js';

const CREATOR = PlayerId.parse('f47ac10b-58cc-4372-a567-0e02b2c3d479');
/** Somebody else, for the cases that turn on who owns what rather than on who is signed in. */
const OTHER = PlayerId.parse('3e7a1b95-2c48-4d6f-8a01-5b9e7c3d2f46');
const GAME_ID = GameId.parse('9f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f');
const OTHER_GAME_ID = GameId.parse('2b6d4f8a-1c3e-4d5f-9a7b-6c8d0e2f4a1b');
const SESSION_ID = SessionId.parse('5d9a0c3b-7e21-4f44-9b0d-3c5e7a9f1b24');
const TASK_ID = TaskId.parse('8c2e4a60-5d17-4b93-8f0a-1e6d2c4b7a35');
const SERVER_URL = `wss://box.example/v1/instances/${SESSION_ID}`;
const CREDENTIALS = { email: 'creator@grove.example', password: 'correct horse' };
const BALANCER = '10.0.0.9';
/** What `randomUUID` mints, which is what an unusable presented id has to be replaced by. */
const MINTED = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const FLEET = {
    FLEET_SECRET: 'c'.repeat(32),
    SERVER_MANAGER_URL: 'http://server-manager.grove.internal:4003',
};

const env = readEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'a'.repeat(32),
    GAME_TOKEN_SECRET: 'b'.repeat(32),
    TRUSTED_PROXIES: BALANCER,
    PLATFORM_ORIGIN: 'https://grove.example',
    EDITOR_ORIGIN: 'https://editor.grove.example',
    ...FLEET,
});

/** The deployed shape: TLS ends at a proxy this service believes, and the loopback peer is it. */
const deployed = readEnv({
    NODE_ENV: 'production',
    SESSION_SECRET: 'a'.repeat(32),
    GAME_TOKEN_SECRET: 'b'.repeat(32),
    TRUSTED_PROXIES: 'loopback',
    PLATFORM_ORIGIN: 'https://grove.example',
    EDITOR_ORIGIN: 'https://editor.grove.example',
    ...FLEET,
});

const HASH = 'a'.repeat(64);

/** The version a build registered, which is what the allocator sends a player at. */
const PLAYABLE: PlayableVersion = {
    revision: 2,
    bundles: {
        server: {
            side: 'server',
            hash: HASH,
            url: `https://cdn.grove.example/b/${HASH}`,
            byteLength: 81_920,
        },
        client: {
            side: 'client',
            hash: HASH,
            url: `https://cdn.grove.example/b/${HASH}`,
            byteLength: 65_536,
        },
        simConfig: {
            hash: HASH,
            url: `https://cdn.grove.example/b/${HASH}.json`,
            byteLength: 128,
        },
        syncedHash: HASH,
    },
};

// Spread rather than listed, so widening the seam cannot silently give this double an answer the
// suite never meant it to have: anything not overridden here is the unattached answer.
const records: Records = {
    ...unattachedRecords,
    signIn: async (email, password) =>
        email === CREDENTIALS.email && password === CREDENTIALS.password ? CREATOR : undefined,
    ownerOf: async (game) => (game === GAME_ID ? CREATOR : undefined),
    gameOf: async (game) =>
        game === GAME_ID
            ? {
                  gameId: GAME_ID,
                  ownerId: CREATOR,
                  title: 'My Game',
                  visibility: 'public',
                  createdAt: '2026-09-16T00:00:00.000Z',
              }
            : undefined,
    playableVersionOf: async (game) => (game === GAME_ID ? PLAYABLE : undefined),
};

/** A fleet holding a box, which is the only state a ticket is ever minted in. */
const placing: Fleet = {
    place: async (_game, _player, version) => ({
        sessionId: SESSION_ID,
        serverUrl: SERVER_URL,
        revision: version.revision,
    }),
};

const FILE = {
    path: 'main.ts',
    kind: 'source',
    versionId: VersionId.parse('KLtFOiCr4.fCdMfe7ZqZ7lXMcmWpqLoP'),
    byteLength: 21,
    contentType: 'text/typescript',
} as const;

/** The set a publish below asks for a build of, already frozen into a manifest by its save. */
const SAVED = {
    gameId: GAME_ID,
    revision: 2,
    files: [FILE],
    updatedAt: '2026-09-16T09:00:00.000Z',
};

/** The build task a publish of that draft queues. */
const BUILD: Task = {
    taskId: TASK_ID,
    gameId: GAME_ID,
    kind: 'BUILD',
    status: 'NOT_STARTED',
    manifestRevision: SAVED.revision,
    attempts: 0,
    createdAt: '2026-09-18T09:00:00.000Z',
    updatedAt: '2026-09-18T09:00:00.000Z',
};

/** The records seam for a game whose editor has saved once and never published. */
function withDraft(revision = SAVED.revision): Records {
    let published: PublishedVersion | undefined;
    let queued: Task | undefined;
    return {
        ...records,
        workspaceOf: async (game) =>
            game === GAME_ID
                ? { ...SAVED, revision, files: revision === 0 ? [] : SAVED.files }
                : undefined,
        publishedVersionOf: async () => published,
        markPublished: async (_game, version) => {
            published = version;
        },
        // The real one returns the live row rather than making a second, which is what a second
        // publish of one manifest has to get back.
        queueTask: async (_game, _account, kind, manifestRevision) => {
            if (queued !== undefined) return { outcome: 'existing', task: queued };
            queued = { ...BUILD, kind, manifestRevision };
            return { outcome: 'queued', task: queued };
        },
        taskOf: async (game, task) =>
            game === GAME_ID && task === queued?.taskId ? queued : undefined,
    };
}

/** A stream that takes every push and remembers what it was told. */
function announcing(): TaskQueue & { pushed: { kind: TaskKind; taskId: TaskId }[] } {
    const pushed: { kind: TaskKind; taskId: TaskId }[] = [];
    return {
        pushed,
        push: async (kind, taskId) => {
            pushed.push({ kind, taskId });
            return { outcome: 'pushed' };
        },
        close: async () => undefined,
    };
}

/** Signs in, and hands back the two things every later write has to carry. */
async function signIn(
    app: FastifyInstance,
    headers: Record<string, string> = {},
): Promise<{ cookie: string; csrfToken: string }> {
    const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/sessions',
        headers,
        payload: CREDENTIALS,
    });
    expect(response.statusCode).toBe(200);
    const cookie = response.cookies.find((candidate) => candidate.name === 'sessionId');
    return { cookie: `sessionId=${cookie?.value ?? ''}`, csrfToken: response.json().csrfToken };
}

/** What one sign-in attempt had left of its bucket, which is what names the bucket it landed in. */
async function attempt(
    app: FastifyInstance,
    remoteAddress: string,
    forwardedFor: string,
): Promise<number> {
    const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/sessions',
        remoteAddress,
        headers: { 'x-forwarded-for': forwardedFor },
        payload: { email: 'stranger@grove.example', password: 'guess' },
    });
    return Number(response.headers['x-ratelimit-remaining']);
}

/** What the store hands back for an id, which is null for one it no longer holds. */
function read(store: ExpiringSessionStore, sessionId: string): Session | null | undefined {
    let found: Session | null | undefined;
    store.get(sessionId, (_error, session) => {
        found = session;
    });
    return found;
}

describe('a request with no session', () => {
    it('cannot read a friend list', async () => {
        const app = await buildApp(env, records);
        const response = await app.inject({ method: 'GET', url: '/v1/social/friends' });
        expect(response.statusCode).toBe(401);
        expect(response.json().code).toBe('unauthorized');
    });

    it('cannot ask for a place in a game', async () => {
        const app = await buildApp(env, records);
        const response = await app.inject({ method: 'POST', url: `/v1/games/${GAME_ID}/play` });
        expect(response.statusCode).toBe(401);
    });

    it('is refused credentials no account answers to', async () => {
        const app = await buildApp(env, records);
        const response = await app.inject({
            method: 'POST',
            url: '/v1/auth/sessions',
            payload: { email: 'stranger@grove.example', password: 'guess' },
        });
        expect(response.statusCode).toBe(401);
        expect(response.headers['set-cookie']).toBeUndefined();
    });
});

describe('the liveness probe', () => {
    it('answers without minting a session for it', async () => {
        const app = await buildApp(env, records);
        const response = await app.inject({ method: 'GET', url: '/health' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
        expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('sits outside the budget that rations real traffic', async () => {
        const app = await buildApp(env, records);
        const response = await app.inject({ method: 'GET', url: '/health' });
        expect(response.headers['x-ratelimit-limit']).toBeUndefined();
    });
});

describe('the correlation id', () => {
    it('answers under the one a caller presented, which is how two logs join', async () => {
        const app = await buildApp(env, records);
        const response = await app.inject({
            method: 'GET',
            url: '/health',
            headers: { [REQUEST_ID_HEADER]: 'known-id' },
        });
        expect(response.headers[REQUEST_ID_HEADER]).toBe('known-id');
    });

    it('replaces one too long for a log line rather than writing it down', async () => {
        const app = await buildApp(env, records);
        const presented = 'a'.repeat(REQUEST_ID_MAX_LENGTH + 1);
        const response = await app.inject({
            method: 'GET',
            url: '/health',
            headers: { [REQUEST_ID_HEADER]: presented },
        });
        expect(response.headers[REQUEST_ID_HEADER]).not.toBe(presented);
        expect(String(response.headers[REQUEST_ID_HEADER])).toMatch(MINTED);
    });

    it('mints one for a caller that presented none', async () => {
        const app = await buildApp(env, records);
        const response = await app.inject({ method: 'GET', url: '/health' });
        expect(String(response.headers[REQUEST_ID_HEADER])).toMatch(MINTED);
    });

    it('reaches the router the join is handed to, which is where the chain broke', async () => {
        let asked: string | undefined;
        const recording: Fleet = {
            place: async (_game, _player, version, requestId) => {
                asked = requestId;
                return {
                    sessionId: SESSION_ID,
                    serverUrl: SERVER_URL,
                    revision: version.revision,
                };
            },
        };
        const app = await buildApp(env, records, recording);
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/play`,
            headers: { cookie, 'x-csrf-token': csrfToken, [REQUEST_ID_HEADER]: 'known-id' },
        });

        expect(response.statusCode).toBe(200);
        expect(asked).toBe('known-id');
    });

    it('answers a publish under the id the creator presented', async () => {
        const app = await buildApp(env, withDraft(), unattachedFleet, undefined, announcing());
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/versions`,
            headers: { cookie, 'x-csrf-token': csrfToken, [REQUEST_ID_HEADER]: 'known-id' },
        });

        expect(response.statusCode).toBe(202);
        expect(response.headers[REQUEST_ID_HEADER]).toBe('known-id');
    });

    it('rides the 500 the error handler wrote, which is the answer most worth tracing', async () => {
        const broken: Fleet = {
            place: async () => {
                throw new Error('server-manager answered 503');
            },
        };
        const app = await buildApp(env, records, broken);
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/play`,
            headers: { cookie, 'x-csrf-token': csrfToken, [REQUEST_ID_HEADER]: 'known-id' },
        });

        expect(response.statusCode).toBe(500);
        expect(response.headers[REQUEST_ID_HEADER]).toBe('known-id');
    });

    it('rides a refusal too, which is the answer an operator is tracing', async () => {
        const app = await buildApp(env, records);
        const response = await app.inject({
            method: 'GET',
            url: '/v1/social/friends',
            headers: { [REQUEST_ID_HEADER]: 'known-id' },
        });
        expect(response.statusCode).toBe(401);
        expect(response.headers[REQUEST_ID_HEADER]).toBe('known-id');
    });
});

describe('the session cookie', () => {
    it('is one no script can read and no cross-site form can send', async () => {
        const app = await buildApp(env, records);
        const response = await app.inject({
            method: 'POST',
            url: '/v1/auth/sessions',
            payload: CREDENTIALS,
        });
        const cookie = response.cookies.find((candidate) => candidate.name === 'sessionId');
        expect(cookie?.httpOnly).toBe(true);
        expect(String(cookie?.sameSite).toLowerCase()).toBe('lax');
        expect(cookie?.secure ?? false).toBe(false);
    });

    it('carries Secure once the environment says it is deployed', async () => {
        const app = await buildApp(deployed, records);
        const response = await app.inject({
            method: 'POST',
            url: '/v1/auth/sessions',
            headers: { 'x-forwarded-proto': 'https' },
            payload: CREDENTIALS,
        });
        const cookie = response.cookies.find((candidate) => candidate.name === 'sessionId');
        expect(cookie?.secure).toBe(true);
    });

    it('is the only thing the environment reader will let a deploy leave unsaid', () => {
        expect(() => readEnv({ SESSION_SECRET: 'a'.repeat(32) })).toThrow(/NODE_ENV/u);
    });
});

describe('the forwarded address', () => {
    it('is the socket when the caller is not one of the named proxies', async () => {
        const app = await buildApp(env, records);
        const first = await attempt(app, '203.0.113.7', '198.51.100.1');
        const second = await attempt(app, '203.0.113.7', '198.51.100.2');
        expect(second).toBe(first - 1);
    });

    it('is the header when the named proxy is the one that wrote it', async () => {
        const app = await buildApp(env, records);
        const first = await attempt(app, BALANCER, '198.51.100.1');
        const second = await attempt(app, BALANCER, '198.51.100.2');
        expect(second).toBe(first);
    });
});

describe('the CSRF token', () => {
    it('is refused when a write carries the cookie and nothing else', async () => {
        const app = await buildApp(env, records);
        const { cookie } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/play`,
            headers: { cookie },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('forbidden');
    });

    it('lets the write reach its handler once it rides along', async () => {
        const app = await buildApp(env, records);
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/play`,
            headers: { cookie, 'x-csrf-token': csrfToken },
        });
        // No fleet behind the allocator, so the far side of the gate is a placement failure.
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('conflict');
    });

    it('is asked of nobody on a read', async () => {
        const app = await buildApp(env, records);
        const { cookie } = await signIn(app);
        const response = await app.inject({
            method: 'GET',
            url: `/v1/games/${GAME_ID}/versions/latest`,
            headers: { cookie },
        });
        expect(response.statusCode).toBe(404);
        expect(response.json().code).toBe('not_found');
    });

    it('is handed back to a browser that kept the cookie and lost the token', async () => {
        const app = await buildApp(env, records);
        const { cookie } = await signIn(app);
        const fetched = await app.inject({
            method: 'GET',
            url: '/v1/auth/session',
            headers: { cookie },
        });
        expect(fetched.statusCode).toBe(200);
        expect(fetched.json().playerId).toBe(CREATOR);
        const write = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/play`,
            headers: { cookie, 'x-csrf-token': fetched.json().csrfToken },
        });
        // Past the gate: the allocator has no fleet behind it.
        expect(write.statusCode).toBe(409);
    });

    it('is minted for nobody who has not signed in', async () => {
        const app = await buildApp(env, records);
        const response = await app.inject({ method: 'GET', url: '/v1/auth/session' });
        expect(response.statusCode).toBe(401);
        expect(response.headers['set-cookie']).toBeUndefined();
    });
});

describe('signing out', () => {
    it('is refused when it carries the cookie and nothing else', async () => {
        const app = await buildApp(env, records);
        const { cookie } = await signIn(app);
        const response = await app.inject({
            method: 'DELETE',
            url: '/v1/auth/sessions/current',
            headers: { cookie },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('forbidden');
        const still = await app.inject({
            method: 'GET',
            url: '/v1/social/friends',
            headers: { cookie },
        });
        expect(still.statusCode).toBe(200);
    });

    it('ends the session once the token rides along', async () => {
        const app = await buildApp(env, records);
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'DELETE',
            url: '/v1/auth/sessions/current',
            headers: { cookie, 'x-csrf-token': csrfToken },
        });
        expect(response.statusCode).toBe(204);
        const after = await app.inject({
            method: 'GET',
            url: '/v1/social/friends',
            headers: { cookie },
        });
        expect(after.statusCode).toBe(401);
    });
});

describe('signing in again', () => {
    it('leaves the cookie the last sign-in handed out answering for nobody', async () => {
        const app = await buildApp(env, records);
        const first = await signIn(app);
        const second = await signIn(app, { cookie: first.cookie });
        const stale = await app.inject({
            method: 'GET',
            url: '/v1/social/friends',
            headers: { cookie: first.cookie },
        });
        expect(stale.statusCode).toBe(401);
        const live = await app.inject({
            method: 'GET',
            url: '/v1/social/friends',
            headers: { cookie: second.cookie },
        });
        expect(live.statusCode).toBe(200);
    });
});

describe('the allocator', () => {
    it('mints a ticket for the player the cookie names, scoped to the box that answered', async () => {
        const app = await buildApp(env, records, placing);
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/play`,
            headers: { cookie, 'x-csrf-token': csrfToken },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().serverUrl).toBe(SERVER_URL);
        expect(
            verifySessionToken(
                response.json().ticket,
                'b'.repeat(32),
                Math.floor(Date.now() / 1000),
                'game-instance',
            ),
        ).toMatchObject({
            ok: true,
            claims: { playerId: CREATOR, gameId: GAME_ID, sessionId: SESSION_ID },
        });
    });

    it('hands over the version the session is on, and the code that goes with it', async () => {
        const app = await buildApp(env, records, placing);
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/play`,
            headers: { cookie, 'x-csrf-token': csrfToken },
        });

        // Without these the browser has to guess which build its session is running, and a guess
        // that misses is a client admitted into a world holding none of its scripts.
        expect(response.json()).toMatchObject({
            revision: PLAYABLE.revision,
            bundles: PLAYABLE.bundles,
        });
    });

    it('refuses a game whose build has never finished', async () => {
        const unbuilt: Records = { ...records, playableVersionOf: async () => undefined };
        const app = await buildApp(env, unbuilt, placing);
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/play`,
            headers: { cookie, 'x-csrf-token': csrfToken },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json().message).toBe('no playable build');
    });

    it('answers a private game somebody else owns the way it answers one that is not there', async () => {
        const hidden: Records = {
            ...records,
            gameOf: async (game) =>
                game === GAME_ID
                    ? {
                          gameId: GAME_ID,
                          ownerId: OTHER,
                          title: 'Not Yours',
                          visibility: 'private',
                          createdAt: '2026-09-16T00:00:00.000Z',
                      }
                    : undefined,
        };
        const app = await buildApp(env, hidden, placing);
        const { cookie, csrfToken } = await signIn(app);

        const refused = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/play`,
            headers: { cookie, 'x-csrf-token': csrfToken },
        });
        const missing = await app.inject({
            method: 'POST',
            url: `/v1/games/${OTHER_GAME_ID}/play`,
            headers: { cookie, 'x-csrf-token': csrfToken },
        });

        // One answer for both: a 403 on the first would confirm the id names a real game to
        // anybody who guessed it.
        expect(refused.statusCode).toBe(404);
        expect(refused.json()).toEqual(missing.json());
    });

    it('lets the owner into their own private game', async () => {
        const mine: Records = {
            ...records,
            gameOf: async (game) =>
                game === GAME_ID
                    ? {
                          gameId: GAME_ID,
                          ownerId: CREATOR,
                          title: 'My Game',
                          visibility: 'private',
                          createdAt: '2026-09-16T00:00:00.000Z',
                      }
                    : undefined,
        };
        const app = await buildApp(env, mine, placing);
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/play`,
            headers: { cookie, 'x-csrf-token': csrfToken },
        });

        expect(response.statusCode).toBe(200);
    });

    it('has nowhere to put a session while no fleet is behind the seam', async () => {
        const app = await buildApp(env, records, unattachedFleet);
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/play`,
            headers: { cookie, 'x-csrf-token': csrfToken },
        });
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('conflict');
    });

    it('does not report a router that failed as a fleet that is full', async () => {
        const broken: Fleet = {
            place: async () => {
                throw new Error('server-manager answered 503');
            },
        };
        const app = await buildApp(env, records, broken);
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/play`,
            headers: { cookie, 'x-csrf-token': csrfToken },
        });
        expect(response.statusCode).toBe(500);
        expect(response.json().code).toBe('internal');
    });
});

describe('publishing', () => {
    /** Signs in and asks for a version of `game`, which is a write and so carries the token. */
    async function publish(app: FastifyInstance, game = GAME_ID) {
        const { cookie, csrfToken } = await signIn(app);
        return app.inject({
            method: 'POST',
            url: `/v1/games/${game}/versions`,
            headers: { cookie, 'x-csrf-token': csrfToken },
        });
    }

    it('refuses a publish of a game the viewer does not own', async () => {
        const app = await buildApp(env, withDraft(), unattachedFleet, undefined, announcing());
        const response = await publish(app, OTHER_GAME_ID);
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('forbidden');
    });

    it('refuses to read what another owner published', async () => {
        const app = await buildApp(env, records);
        const { cookie } = await signIn(app);
        const response = await app.inject({
            method: 'GET',
            url: `/v1/games/${OTHER_GAME_ID}/versions/latest`,
            headers: { cookie },
        });
        expect(response.statusCode).toBe(403);
    });

    it('queues a build pinned to the manifest the last save froze, and announces it', async () => {
        const queue = announcing();
        const app = await buildApp(env, withDraft(), unattachedFleet, undefined, queue);

        const response = await publish(app);
        expect(response.statusCode).toBe(202);
        expect(response.json()).toMatchObject({
            taskId: TASK_ID,
            kind: 'BUILD',
            status: 'NOT_STARTED',
            // The saved revision and not whatever the editor has typed since, which is the whole
            // of what pinning a task to a manifest buys.
            manifestRevision: 2,
        });
        expect(queue.pushed).toEqual([{ kind: 'BUILD', taskId: TASK_ID }]);
    });

    it('hands the same task back twice rather than building one manifest twice', async () => {
        const queue = announcing();
        const app = await buildApp(env, withDraft(), unattachedFleet, undefined, queue);

        const first = await publish(app);
        const second = await publish(app);
        expect(second.statusCode).toBe(202);
        expect(second.json().taskId).toBe(first.json().taskId);
        // Announced both times all the same: the push is the half that goes missing, and a second
        // message for a task already claimed is one a consumer group drops.
        expect(queue.pushed).toHaveLength(2);
    });

    it('hands back the version, and answers for it afterwards', async () => {
        const app = await buildApp(env, withDraft(), unattachedFleet, undefined, announcing());
        expect((await publish(app)).statusCode).toBe(202);

        const { cookie } = await signIn(app);
        const latest = await app.inject({
            method: 'GET',
            url: `/v1/games/${GAME_ID}/versions/latest`,
            headers: { cookie },
        });
        expect(latest.statusCode).toBe(200);
        expect(latest.json()).toMatchObject({ revision: 2 });
    });

    it('is a 404 for a game that never published, and never a version of nothing', async () => {
        const app = await buildApp(env, withDraft(), unattachedFleet, undefined, announcing());
        const { cookie } = await signIn(app);
        const latest = await app.inject({
            method: 'GET',
            url: `/v1/games/${GAME_ID}/versions/latest`,
            headers: { cookie },
        });
        expect(latest.statusCode).toBe(404);
    });

    it('refuses to publish a game whose editor has never saved', async () => {
        const app = await buildApp(env, withDraft(0), unattachedFleet, undefined, announcing());
        const response = await publish(app);
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('conflict');
    });

    it('refuses rather than handing back a task id nothing will answer for', async () => {
        const app = await buildApp(env, records, unattachedFleet, undefined, announcing());
        const withGame: Records = {
            ...records,
            workspaceOf: async () => SAVED,
        };
        const unwritable = await buildApp(env, withGame, unattachedFleet, undefined, announcing());
        expect((await publish(unwritable)).statusCode).toBe(501);
        expect((await publish(app, OTHER_GAME_ID)).statusCode).toBe(403);
    });

    it('still records the version when the stream would not take the announcement', async () => {
        // The row is committed and the sweeper re-pushes it, so a creator is told their game was
        // published rather than being sent to press the button again.
        const holder = withDraft();
        const app = await buildApp(env, holder, unattachedFleet, undefined, unattachedQueue);
        expect((await publish(app)).statusCode).toBe(202);
        expect(await holder.publishedVersionOf(GAME_ID)).toMatchObject({ revision: 2 });
    });
});

describe('the task a creator is watching', () => {
    it('is readable by the owner of the game it belongs to', async () => {
        const app = await buildApp(env, withDraft(), unattachedFleet, undefined, announcing());
        const { cookie, csrfToken } = await signIn(app);
        await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/versions`,
            headers: { cookie, 'x-csrf-token': csrfToken },
        });

        const response = await app.inject({
            method: 'GET',
            url: `/v1/games/${GAME_ID}/tasks/${TASK_ID}`,
            headers: { cookie },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().taskId).toBe(TASK_ID);
    });

    it('is refused for a game the viewer does not own', async () => {
        const app = await buildApp(env, withDraft(), unattachedFleet, undefined, announcing());
        const { cookie } = await signIn(app);
        const response = await app.inject({
            method: 'GET',
            url: `/v1/games/${OTHER_GAME_ID}/tasks/${TASK_ID}`,
            headers: { cookie },
        });
        expect(response.statusCode).toBe(403);
    });
});

describe('a worker settling a task', () => {
    const BEARER = { authorization: `Bearer ${FLEET.FLEET_SECRET}` };

    /** A records seam holding one task, which advances the way the real statement does. */
    function holding(status: Task['status'] = 'NOT_STARTED'): Records {
        let task: Task = { ...BUILD, status };
        return {
            ...records,
            advanceTask: async (taskId, update) => {
                if (taskId !== task.taskId) return { outcome: 'missing' };
                if (task.status === 'SUCCESSFUL' || task.status === 'FAILED') {
                    return { outcome: 'backwards', task };
                }
                task = { ...task, status: update.status, detail: update.detail };
                return { outcome: 'advanced', task };
            },
        };
    }

    it('needs the fleet bearer, which no browser cookie ever stands in for', async () => {
        const app = await buildApp(env, holding());
        const response = await app.inject({
            method: 'PATCH',
            url: `/v1/tasks/${TASK_ID}`,
            payload: { status: 'IN_PROGRESS' },
        });
        expect(response.statusCode).toBe(401);
    });

    it('claims it, and says so', async () => {
        const app = await buildApp(env, holding());
        const response = await app.inject({
            method: 'PATCH',
            url: `/v1/tasks/${TASK_ID}`,
            headers: BEARER,
            payload: { status: 'IN_PROGRESS' },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().status).toBe('IN_PROGRESS');
    });

    it('cannot walk a settled task backwards, however often the message is redelivered', async () => {
        const app = await buildApp(env, holding('SUCCESSFUL'));
        const response = await app.inject({
            method: 'PATCH',
            url: `/v1/tasks/${TASK_ID}`,
            headers: BEARER,
            payload: { status: 'IN_PROGRESS' },
        });
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('conflict');
    });

    it('cannot put one back in the state the sweeper re-pushes from', async () => {
        const app = await buildApp(env, holding('IN_PROGRESS'));
        const response = await app.inject({
            method: 'PATCH',
            url: `/v1/tasks/${TASK_ID}`,
            headers: BEARER,
            payload: { status: 'NOT_STARTED' },
        });
        expect(response.statusCode).toBe(400);
    });
});

describe('the spec', () => {
    it('is served where a creator toolchain can read it', async () => {
        const app = await buildApp(env, records);
        const response = await app.inject({ method: 'GET', url: '/docs/json' });
        expect(response.statusCode).toBe(200);
        expect(Object.keys(response.json().paths)).toContain('/v1/auth/sessions');
    });

    it('is not published by the deployment facing the internet', async () => {
        const app = await buildApp(deployed, records);
        const response = await app.inject({ method: 'GET', url: '/docs/json' });
        expect(response.statusCode).toBe(404);
    });
});

describe('the session store', () => {
    const TTL_MS = 1_000;

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function held(): Session {
        return { cookie: { originalMaxAge: TTL_MS } };
    }

    it('forgets a session that outlived the cookie naming it', () => {
        const store = new ExpiringSessionStore(TTL_MS);
        store.set('one', held(), () => {});
        vi.advanceTimersByTime(TTL_MS + 1);
        expect(read(store, 'one')).toBeNull();
    });

    it('drops the oldest rather than growing past its ceiling', () => {
        const store = new ExpiringSessionStore(TTL_MS, 2);
        store.set('one', held(), () => {});
        store.set('two', held(), () => {});
        store.set('three', held(), () => {});
        expect(read(store, 'one')).toBeNull();
        expect(read(store, 'three')).not.toBeNull();
    });

    it('keeps one alive for as long as its owner keeps using it', () => {
        const store = new ExpiringSessionStore(TTL_MS);
        const session = held();
        store.set('one', session, () => {});
        vi.advanceTimersByTime(TTL_MS - 1);
        store.set('one', session, () => {});
        vi.advanceTimersByTime(TTL_MS - 1);
        expect(read(store, 'one')).toBe(session);
    });

    // The plugin runs with `rolling` on, so a request already in flight when a session is revoked
    // saves it again on its way out, from the object it loaded beforehand. Without a tombstone that
    // one write undoes a sign-out, a password change and an account closure alike.
    it('refuses to take back a session that was revoked while a request held it', () => {
        const store = new ExpiringSessionStore(TTL_MS);
        const session = held();
        store.set('one', session, () => {});
        store.destroy('one', () => {});
        store.set('one', session, () => {});
        expect(read(store, 'one')).toBeNull();
    });

    it('revokes every session one account holds, and nobody else’s', () => {
        const store = new ExpiringSessionStore(TTL_MS);
        const stranger = PlayerId.parse('7c4a8d09-ca37-4f2b-9e1a-3b5c7d9e0f12');
        const mine = { ...held(), playerId: CREATOR };
        const theirs = { ...held(), playerId: stranger };
        store.set('one', mine, () => {});
        store.set('two', mine, () => {});
        store.set('three', theirs, () => {});

        store.destroyFor(CREATOR);
        expect(read(store, 'one')).toBeNull();
        expect(read(store, 'two')).toBeNull();
        expect(read(store, 'three')).not.toBeNull();
    });

    it('lets a revoked id go once the cookie naming it could not be presented anyway', () => {
        const store = new ExpiringSessionStore(TTL_MS);
        store.set('one', held(), () => {});
        store.destroy('one', () => {});
        vi.advanceTimersByTime(TTL_MS + 1);
        store.set('one', held(), () => {});
        expect(read(store, 'one')).not.toBeNull();
    });
});
