import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { REQUEST_ID_HEADER, REQUEST_ID_MAX_LENGTH, WorkspacePath } from '@grove/api-contract';
import type { PlayableVersion, PublishedVersion, Task } from '@grove/api-contract';
import { verifyTicket } from '@grove/api-contract/tokens';
import { buildApp, type Dependencies } from '../src/app.js';
import { readEnv } from '../src/env.js';
import type { Fleet } from '../src/fleet.js';
import { unattachedQueue } from '../src/queue.js';
import type { BuildQueued, Stores } from '../src/records.js';
import { announcing, stores, type StoreOverrides } from './doubles.js';
import {
    ASSET_SERVICE_SECRET,
    BUILDER_SECRET,
    CREATOR,
    GAME_ID,
    OTHER_GAME_ID,
    OTHER_PLAYER,
    SESSION_ID,
    TASK_ID,
    TICKET_KEY,
    bearer,
    signIn as signInWith,
    testEnv,
} from './fixtures.js';

const SERVER_URL = `wss://box.example/play/${SESSION_ID}`;
const CREDENTIALS = { email: 'creator@grove.example', password: 'correct horse' };
const BALANCER = '10.0.0.9';
/** What `randomUUID` mints, which is what an unusable presented id has to be replaced by. */
const MINTED = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const env = testEnv({ TRUSTED_PROXIES: BALANCER });

/** The deployed shape: TLS ends at a proxy this service believes, and the loopback peer is it. */
const deployed = testEnv({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://grove@db.grove.internal/grove',
    GAMES_BUCKET: 'grove-games',
    REDIS_URL: 'redis://redis.grove.internal:6379',
});

const HASH = 'a'.repeat(64);

/** The version a build registered, which is what the allocator sends a player at. */
const PLAYABLE: PlayableVersion = {
    revision: 2,
    projectId: 'leaf-harvest',
    projectHash: 'b'.repeat(64),
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
        simConfig: { hash: HASH, url: `https://cdn.grove.example/b/${HASH}.json`, byteLength: 128 },
        syncedHash: HASH,
    },
};

/** One public game the creator owns, with a version anybody may play. */
const BASE: StoreOverrides = {
    accounts: {
        signIn: async (email, password) =>
            email === CREDENTIALS.email && password === CREDENTIALS.password ? CREATOR : undefined,
    },
    games: {
        ownerOf: async (game) => (game === GAME_ID ? CREATOR : undefined),
        gameOf: async (game) =>
            game === GAME_ID
                ? {
                      gameId: GAME_ID,
                      ownerId: CREATOR,
                      title: 'My Game',
                      visibility: 'public',
                      createdAt: '2026-09-16T00:00:00.000Z',
                      publishedAt: null,
                  }
                : undefined,
    },
    tasks: { playableVersionOf: async (game) => (game === GAME_ID ? PLAYABLE : undefined) },
};

function holding(over: StoreOverrides = {}): Stores {
    return stores({
        accounts: { ...BASE.accounts, ...over.accounts },
        games: { ...BASE.games, ...over.games },
        workspaces: over.workspaces,
        tasks: { ...BASE.tasks, ...over.tasks },
        fleetHistory: over.fleetHistory,
    });
}

const serve = (deps: Partial<Dependencies> = {}, at = env) =>
    buildApp(at, { ...holding(), ...deps });

/** A fleet holding a box, which is the only state a ticket is ever minted in. */
const placing: Fleet = {
    place: async (_game, _player, version) => ({
        sessionId: SESSION_ID,
        serverUrl: SERVER_URL,
        revision: version.revision,
    }),
    deploy: async () => undefined,
};

const BUILD: Task = {
    taskId: TASK_ID,
    gameId: GAME_ID,
    kind: 'BUILD',
    status: 'NOT_STARTED',
    manifestRevision: 2,
    attempts: 0,
    createdAt: '2026-09-18T09:00:00.000Z',
    updatedAt: '2026-09-18T09:00:00.000Z',
};

/** A game saved once and never published, pinned the way the real store pins it. */
function withDraft(revision = 2, unverified: WorkspacePath[] = []): Stores {
    let published: PublishedVersion | undefined;
    let queued: Task | undefined;
    return holding({
        workspaces: {
            workspaceOf: async (game) =>
                game === GAME_ID
                    ? {
                          gameId: GAME_ID,
                          revision,
                          saveId: 'b0d8b3f2-6a7e-4d2c-9a1f-3e5c7b9d1f20',
                          files: [],
                          updatedAt: '2026-09-16T09:00:00.000Z',
                      }
                    : undefined,
        },
        games: {
            publishedVersionOf: async () => published,
            markPublished: async (_game, version) => {
                published = version;
            },
        },
        tasks: {
            queueBuild: async (_game, _account, asked): Promise<BuildQueued> => {
                if (unverified.length > 0) return { outcome: 'unverified', paths: unverified };
                if (asked !== revision) return { outcome: 'moved' };
                if (queued !== undefined) return { outcome: 'existing', task: queued };
                queued = { ...BUILD, manifestRevision: asked };
                return { outcome: 'queued', task: queued };
            },
            taskOf: async (game, task) =>
                game === GAME_ID && task === queued?.taskId ? queued : undefined,
        },
    });
}

const signIn = (app: FastifyInstance, headers: Record<string, string> = {}) =>
    signInWith(app, CREDENTIALS, headers);

/** What one sign-in attempt had left of its bucket, which names the bucket it landed in. */
async function attempt(app: FastifyInstance, remoteAddress: string, forwardedFor: string) {
    const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/sessions',
        remoteAddress,
        headers: { 'x-forwarded-for': forwardedFor },
        payload: { email: 'stranger@grove.example', password: 'guess' },
    });
    return Number(response.headers['x-ratelimit-remaining']);
}

describe('a request with no session', () => {
    it('cannot read a friend list, or ask for a place in a game', async () => {
        const app = await serve();
        const friends = await app.inject({ method: 'GET', url: '/v1/social/friends' });
        expect(friends.statusCode).toBe(401);
        expect(friends.json().code).toBe('unauthorized');
        expect(
            (await app.inject({ method: 'POST', url: `/v1/games/${GAME_ID}/play` })).statusCode,
        ).toBe(401);
    });

    it('is refused credentials no account answers to, and handed no cookie', async () => {
        const app = await serve();
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
    it('answers without minting a session, outside the budget that rations real traffic', async () => {
        const app = await serve();
        const response = await app.inject({ method: 'GET', url: '/health' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
        expect(response.headers['set-cookie']).toBeUndefined();
        expect(response.headers['x-ratelimit-limit']).toBeUndefined();
    });
});

describe('the correlation id', () => {
    it('answers under the one a caller presented, and replaces one too long for a log line', async () => {
        const app = await serve();
        const kept = await app.inject({
            method: 'GET',
            url: '/health',
            headers: { [REQUEST_ID_HEADER]: 'known-id' },
        });
        expect(kept.headers[REQUEST_ID_HEADER]).toBe('known-id');

        const presented = 'a'.repeat(REQUEST_ID_MAX_LENGTH + 1);
        const replaced = await app.inject({
            method: 'GET',
            url: '/health',
            headers: { [REQUEST_ID_HEADER]: presented },
        });
        expect(String(replaced.headers[REQUEST_ID_HEADER])).toMatch(MINTED);
    });

    it('reaches the router the join is handed to, which is where the chain broke', async () => {
        let asked: string | undefined;
        const app = await serve({
            fleet: {
                ...placing,
                place: async (game, player, version, requestId) => {
                    asked = requestId;
                    return placing.place(game, player, version, requestId);
                },
            },
        });
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/play`,
            headers: { cookie, 'x-csrf-token': csrfToken, [REQUEST_ID_HEADER]: 'known-id' },
        });
        expect(response.statusCode).toBe(200);
        expect(asked).toBe('known-id');
    });

    it('rides the 500 the error handler wrote, which is the answer most worth tracing', async () => {
        const app = await serve({
            fleet: {
                ...placing,
                place: async () => {
                    throw new Error('server-manager answered 503');
                },
            },
        });
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/play`,
            headers: { cookie, 'x-csrf-token': csrfToken, [REQUEST_ID_HEADER]: 'known-id' },
        });
        expect(response.statusCode).toBe(500);
        expect(response.headers[REQUEST_ID_HEADER]).toBe('known-id');
    });
});

describe('the session cookie', () => {
    it('is one no script can read and no cross-site form can send', async () => {
        const app = await serve();
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
        const app = await serve({}, deployed);
        const response = await app.inject({
            method: 'POST',
            url: '/v1/auth/sessions',
            headers: { 'x-forwarded-proto': 'https' },
            payload: CREDENTIALS,
        });
        expect(response.cookies.find((candidate) => candidate.name === 'sessionId')?.secure).toBe(
            true,
        );
    });

    it('is the only thing the environment reader will let a deploy leave unsaid', () => {
        expect(() => readEnv({ SESSION_SECRET: 'a'.repeat(32) })).toThrow(/NODE_ENV/u);
    });
});

describe('the forwarded address', () => {
    it('is the socket when the caller is not one of the named proxies', async () => {
        const app = await serve();
        const first = await attempt(app, '203.0.113.7', '198.51.100.1');
        const second = await attempt(app, '203.0.113.7', '198.51.100.2');
        expect(second).toBe(first - 1);
    });

    it('is the header when the named proxy is the one that wrote it', async () => {
        const app = await serve();
        const first = await attempt(app, BALANCER, '198.51.100.1');
        const second = await attempt(app, BALANCER, '198.51.100.2');
        expect(second).toBe(first);
    });
});

describe('the CSRF token', () => {
    it('is refused as its own code when a write carries the cookie and nothing else', async () => {
        const app = await serve();
        const { cookie } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/play`,
            headers: { cookie },
        });
        expect(response.statusCode).toBe(403);
        // Not `forbidden`: a stale token is mended by re-reading the session, the client's cue.
        expect(response.json().code).toBe('csrf_invalid');
    });

    it('lets the write reach its handler once it rides along, and is asked of nobody on a read', async () => {
        const app = await serve();
        const { cookie, csrfToken } = await signIn(app);
        const write = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/play`,
            headers: { cookie, 'x-csrf-token': csrfToken },
        });
        // No fleet behind the allocator, so the far side of the gate is a placement failure.
        expect(write.statusCode).toBe(409);
        const read = await app.inject({
            method: 'GET',
            url: `/v1/games/${GAME_ID}/versions/latest`,
            headers: { cookie },
        });
        expect(read.statusCode).toBe(404);
    });

    it('is handed back to a browser that kept the cookie and lost the token', async () => {
        const app = await serve();
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
        expect(write.statusCode).toBe(409);
    });

    it('is minted for nobody who has not signed in', async () => {
        const app = await serve();
        const response = await app.inject({ method: 'GET', url: '/v1/auth/session' });
        expect(response.statusCode).toBe(401);
        expect(response.headers['set-cookie']).toBeUndefined();
    });
});

describe('signing out', () => {
    it('is refused when it carries the cookie and nothing else', async () => {
        const app = await serve();
        const { cookie } = await signIn(app);
        const response = await app.inject({
            method: 'DELETE',
            url: '/v1/auth/sessions/current',
            headers: { cookie },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('csrf_invalid');
        const still = await app.inject({
            method: 'GET',
            url: '/v1/social/friends',
            headers: { cookie },
        });
        expect(still.statusCode).toBe(200);
    });

    it('ends the session once the token rides along', async () => {
        const app = await serve();
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
        const app = await serve();
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
    async function join(app: FastifyInstance, game = GAME_ID) {
        const { cookie, csrfToken } = await signIn(app);
        return app.inject({
            method: 'POST',
            url: `/v1/games/${game}/play`,
            headers: { cookie, 'x-csrf-token': csrfToken },
        });
    }

    it('mints a ticket a box holding only the public key verifies, for the player the cookie names', async () => {
        const response = await join(await serve({ fleet: placing }));
        expect(response.statusCode).toBe(200);
        expect(response.json().serverUrl).toBe(SERVER_URL);
        expect(
            verifyTicket(response.json().ticket, TICKET_KEY, Math.floor(Date.now() / 1000)),
        ).toMatchObject({
            ok: true,
            claims: { playerId: CREATOR, gameId: GAME_ID, sessionId: SESSION_ID },
        });
    });

    it('hands over the identity a joiner has to claim, and names no bundle', async () => {
        const response = await join(await serve({ fleet: placing }));
        expect(response.json()).toMatchObject({
            revision: PLAYABLE.revision,
            projectId: PLAYABLE.projectId,
            projectHash: PLAYABLE.projectHash,
        });
        expect(response.json()).not.toHaveProperty('bundles');
    });

    it('refuses a game whose build has never finished', async () => {
        const unbuilt = holding({ tasks: { playableVersionOf: async () => undefined } });
        const response = await join(await buildApp(env, { ...unbuilt, fleet: placing }));
        expect(response.statusCode).toBe(409);
        expect(response.json().message).toBe('no playable build');
    });

    it('answers a private game somebody else owns the way it answers one that is not there', async () => {
        const hidden = holding({
            games: {
                gameOf: async (game) =>
                    game === GAME_ID
                        ? {
                              gameId: GAME_ID,
                              ownerId: OTHER_PLAYER,
                              title: 'Not Yours',
                              visibility: 'private',
                              createdAt: '2026-09-16T00:00:00.000Z',
                              publishedAt: null,
                          }
                        : undefined,
            },
        });
        const app = await buildApp(env, { ...hidden, fleet: placing });
        const refused = await join(app);
        const missing = await join(app, OTHER_GAME_ID);
        expect(refused.statusCode).toBe(404);
        expect(refused.json()).toEqual(missing.json());
    });

    it('does not report a router that failed as a fleet that is full', async () => {
        const app = await serve({
            fleet: {
                ...placing,
                place: async () => {
                    throw new Error('server-manager answered 503');
                },
            },
        });
        const response = await join(app);
        expect(response.statusCode).toBe(500);
        expect(response.json().code).toBe('internal');
    });
});

describe('publishing', () => {
    async function publishOn(app: FastifyInstance, game = GAME_ID) {
        const { cookie, csrfToken } = await signIn(app);
        return app.inject({
            method: 'POST',
            url: `/v1/games/${game}/versions`,
            headers: { cookie, 'x-csrf-token': csrfToken },
        });
    }

    it('refuses a publish of a game the viewer does not own', async () => {
        const app = await buildApp(env, { ...withDraft(), queue: announcing() });
        const response = await publishOn(app, OTHER_GAME_ID);
        expect(response.statusCode).toBe(403);
    });

    it('queues a build pinned to the revision the last save froze, and announces it', async () => {
        const queue = announcing();
        const app = await buildApp(env, { ...withDraft(), queue });
        const response = await publishOn(app);
        expect(response.statusCode).toBe(202);
        expect(response.json()).toMatchObject({
            taskId: TASK_ID,
            kind: 'BUILD',
            manifestRevision: 2,
        });
        expect(queue.pushed).toEqual([{ kind: 'BUILD', taskId: TASK_ID }]);
    });

    it('hands the same task back twice, announcing it both times', async () => {
        const queue = announcing();
        const app = await buildApp(env, { ...withDraft(), queue });
        const first = await publishOn(app);
        const second = await publishOn(app);
        expect(second.json().taskId).toBe(first.json().taskId);
        expect(queue.pushed).toHaveLength(2);
    });

    it('answers for the version afterwards, and a 404 before', async () => {
        const app = await buildApp(env, { ...withDraft(), queue: announcing() });
        const { cookie } = await signIn(app);
        const before = await app.inject({
            method: 'GET',
            url: `/v1/games/${GAME_ID}/versions/latest`,
            headers: { cookie },
        });
        expect(before.statusCode).toBe(404);
        await publishOn(app);
        const after = await app.inject({
            method: 'GET',
            url: `/v1/games/${GAME_ID}/versions/latest`,
            headers: { cookie },
        });
        expect(after.json()).toMatchObject({ revision: 2 });
    });

    it('refuses to publish while an asset is still being verified, and names it', async () => {
        const queue = announcing();
        const app = await buildApp(env, {
            ...withDraft(2, [WorkspacePath.parse('art/hero.png')]),
            queue,
        });
        const response = await publishOn(app);
        expect(response.statusCode).toBe(409);
        expect(response.json().message).toContain('art/hero.png');
        expect(queue.pushed).toEqual([]);
    });

    it('refuses to publish a game whose editor has never saved', async () => {
        const app = await buildApp(env, { ...withDraft(0), queue: announcing() });
        expect((await publishOn(app)).statusCode).toBe(409);
    });

    it('refuses rather than handing back a task id nothing will answer for', async () => {
        const draft = withDraft();
        const app = await buildApp(env, {
            ...draft,
            tasks: { ...draft.tasks, queueBuild: async () => ({ outcome: 'unattached' }) },
            queue: announcing(),
        });
        expect((await publishOn(app)).statusCode).toBe(501);
    });

    it('still records the version when the stream would not take the announcement', async () => {
        const draft = withDraft();
        const app = await buildApp(env, { ...draft, queue: unattachedQueue });
        expect((await publishOn(app)).statusCode).toBe(202);
        expect(await draft.games.publishedVersionOf(GAME_ID)).toMatchObject({ revision: 2 });
    });
});

describe('the task a creator is watching', () => {
    it('is readable by the owner of the game it belongs to, and refused to anybody else', async () => {
        const app = await buildApp(env, { ...withDraft(), queue: announcing() });
        const { cookie, csrfToken } = await signIn(app);
        await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/versions`,
            headers: { cookie, 'x-csrf-token': csrfToken },
        });
        const mine = await app.inject({
            method: 'GET',
            url: `/v1/games/${GAME_ID}/tasks/${TASK_ID}`,
            headers: { cookie },
        });
        expect(mine.json().taskId).toBe(TASK_ID);
        const theirs = await app.inject({
            method: 'GET',
            url: `/v1/games/${OTHER_GAME_ID}/tasks/${TASK_ID}`,
            headers: { cookie },
        });
        expect(theirs.statusCode).toBe(403);
    });
});

describe('a worker settling a task', () => {
    /** One build and one upload, refusing another kind's id as the real store does. */
    function fleet(): Stores {
        const upload: Task = {
            ...BUILD,
            taskId: OTHER_GAME_ID as never,
            kind: 'ASSET_UPLOAD',
            assetPath: WorkspacePath.parse('a.png'),
        };
        const held = new Map<string, Task>([
            [BUILD.taskId, BUILD],
            [upload.taskId, upload],
        ]);
        return holding({
            tasks: {
                claimTask: async (taskId, claim) => {
                    const task = held.get(taskId);
                    if (task === undefined || task.kind !== claim.kind)
                        return { outcome: 'missing' };
                    return {
                        outcome: 'claimed',
                        task: { ...task, status: 'IN_PROGRESS' },
                        leaseUntil: new Date(),
                    };
                },
                settleTask: async (taskId, kind, update) => {
                    const task = held.get(taskId);
                    if (task === undefined || task.kind !== kind) return { outcome: 'missing' };
                    return {
                        outcome: 'settled',
                        task: { ...task, status: update.status },
                        validated: false,
                    };
                },
            },
        });
    }

    it('needs a worker secret, which no browser cookie and no other caller stands in for', async () => {
        const app = await buildApp(env, fleet());
        const patch = (headers: Record<string, string>) =>
            app.inject({
                method: 'PATCH',
                url: `/v1/tasks/${TASK_ID}`,
                headers,
                payload: { status: 'IN_PROGRESS' },
            });
        expect((await patch({})).statusCode).toBe(401);
        expect((await patch(bearer('m'.repeat(32)))).statusCode).toBe(401);
        expect((await patch(bearer(BUILDER_SECRET))).statusCode).toBe(200);
    });

    // A builder's secret reaches builds alone, and the asset service's uploads alone.
    it('answers for one kind of task per secret, and no task of the other kind', async () => {
        const app = await buildApp(env, fleet());
        const patch = (task: string, secret: string) =>
            app.inject({
                method: 'PATCH',
                url: `/v1/tasks/${task}`,
                headers: bearer(secret),
                payload: { status: 'FAILED' },
            });
        expect((await patch(TASK_ID, ASSET_SERVICE_SECRET)).statusCode).toBe(404);
        expect((await patch(OTHER_GAME_ID, BUILDER_SECRET)).statusCode).toBe(404);
        expect((await patch(OTHER_GAME_ID, ASSET_SERVICE_SECRET)).statusCode).toBe(200);
    });

    it('cannot put one back in the state the sweeper re-announces from', async () => {
        const app = await buildApp(env, fleet());
        const response = await app.inject({
            method: 'PATCH',
            url: `/v1/tasks/${TASK_ID}`,
            headers: bearer(BUILDER_SECRET),
            payload: { status: 'NOT_STARTED' },
        });
        expect(response.statusCode).toBe(400);
    });
});

describe('the spec', () => {
    it('is served where a creator toolchain can read it, and not by the deployment', async () => {
        const app = await serve();
        const response = await app.inject({ method: 'GET', url: '/docs/json' });
        expect(response.statusCode).toBe(200);
        expect(Object.keys(response.json().paths)).toContain('/v1/auth/sessions');
        const facing = await serve({}, deployed);
        expect((await facing.inject({ method: 'GET', url: '/docs/json' })).statusCode).toBe(404);
    });
});
