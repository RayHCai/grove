// Every gate in front of a request: the cookie, the token that must ride with it, and what a
// signed-in caller still may not do.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, Session } from 'fastify';
import {
    BuildJobId,
    GameId,
    PlayerId,
    REQUEST_ID_HEADER,
    REQUEST_ID_MAX_LENGTH,
    SessionId,
    verifySessionToken,
} from '@grove/api-contract';
import { buildApp } from '../src/app.js';
import type { Builder } from '../src/builder.js';
import { readEnv } from '../src/env.js';
import { unattachedFleet } from '../src/fleet.js';
import type { Fleet } from '../src/fleet.js';
import type { Records } from '../src/records.js';
import { ExpiringSessionStore } from '../src/session-store.js';

const CREATOR = PlayerId.parse('f47ac10b-58cc-4372-a567-0e02b2c3d479');
const GAME_ID = GameId.parse('9f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f');
const OTHER_GAME_ID = GameId.parse('2b6d4f8a-1c3e-4d5f-9a7b-6c8d0e2f4a1b');
const SESSION_ID = SessionId.parse('5d9a0c3b-7e21-4f44-9b0d-3c5e7a9f1b24');
const JOB_ID = BuildJobId.parse('8c2e4a60-5d17-4b93-8f0a-1e6d2c4b7a35');
const SERVER_URL = `wss://box.example/v1/instances/${SESSION_ID}`;
const CREDENTIALS = { email: 'creator@grove.example', password: 'correct horse' };
const BALANCER = '10.0.0.9';
const BOUNDARY = 'grove-upload-boundary';
const MULTIPART = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
/** What `randomUUID` mints, which is what an unusable presented id has to be replaced by. */
const MINTED = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const FLEET = {
    FLEET_SECRET: 'c'.repeat(32),
    SERVER_MANAGER_URL: 'http://server-manager.grove.internal:4003',
    UPLOAD_SERVICE_URL: 'http://upload-service.grove.internal:4005',
    GAME_BUILDER_URL: 'http://game-builder.grove.internal:4002',
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

const records: Records = {
    signIn: async (email, password) =>
        email === CREDENTIALS.email && password === CREDENTIALS.password ? CREATOR : undefined,
    ownerOf: async (game) => (game === GAME_ID ? CREATOR : undefined),
};

/** A fleet holding a box, which is the only state a ticket is ever minted in. */
const placing: Fleet = {
    place: async () => ({ sessionId: SESSION_ID, serverUrl: SERVER_URL }),
};

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

/** A multipart body with or without the part the publish route is looking for. */
function upload(withFile: boolean): string {
    const part = withFile
        ? 'Content-Disposition: form-data; name="source"; filename="game.zip"\r\n\r\nPK\r\n'
        : 'Content-Disposition: form-data; name="note"\r\n\r\nno file here\r\n';
    return `--${BOUNDARY}\r\n${part}--${BOUNDARY}--\r\n`;
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
            place: async (_game, _player, requestId) => {
                asked = requestId;
                return { sessionId: SESSION_ID, serverUrl: SERVER_URL };
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

    it('reaches the two services a publish crosses, under the id the creator was answered', async () => {
        let asked: string | undefined;
        const recording: Builder = {
            queue: async (_game, _source, requestId) => {
                asked = requestId;
                return { outcome: 'queued', jobId: JOB_ID };
            },
        };
        const app = await buildApp(env, records, unattachedFleet, recording);
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/versions`,
            headers: {
                cookie,
                'x-csrf-token': csrfToken,
                [REQUEST_ID_HEADER]: 'known-id',
                ...MULTIPART,
            },
            payload: upload(true),
        });

        expect(response.statusCode).toBe(202);
        expect(asked).toBe('known-id');
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
    it('refuses an upload to a game the viewer does not own', async () => {
        const app = await buildApp(env, records);
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: `/v1/games/${OTHER_GAME_ID}/versions`,
            headers: { cookie, 'x-csrf-token': csrfToken, ...MULTIPART },
            payload: upload(true),
        });
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

    it('queues the owner build, and answers with the id the builder minted', async () => {
        let handed: Buffer | undefined;
        const queueing: Builder = {
            queue: async (_game, source) => {
                handed = source;
                return { outcome: 'queued', jobId: JOB_ID };
            },
        };
        const app = await buildApp(env, records, unattachedFleet, queueing);
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/versions`,
            headers: { cookie, 'x-csrf-token': csrfToken, ...MULTIPART },
            payload: upload(true),
        });
        expect(response.statusCode).toBe(202);
        expect(response.json().jobId).toBe(JOB_ID);
        expect(handed?.toString('utf8')).toBe('PK');
    });

    it('refuses rather than handing back a job id nothing will answer for', async () => {
        const app = await buildApp(env, records);
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/versions`,
            headers: { cookie, 'x-csrf-token': csrfToken, ...MULTIPART },
            payload: upload(true),
        });
        expect(response.statusCode).toBe(501);
        expect(response.json().code).toBe('internal');
    });

    it('relays a ration as one, so an editor backs off instead of stopping', async () => {
        const rationed: Builder = { queue: async () => ({ outcome: 'rate_limited' }) };
        const app = await buildApp(env, records, unattachedFleet, rationed);
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/versions`,
            headers: { cookie, 'x-csrf-token': csrfToken, ...MULTIPART },
            payload: upload(true),
        });
        expect(response.statusCode).toBe(429);
        expect(response.json().code).toBe('rate_limited');
    });

    it('answers for a pipeline that did not take the build', async () => {
        const broken: Builder = { queue: async () => ({ outcome: 'unavailable' }) };
        const app = await buildApp(env, records, unattachedFleet, broken);
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/versions`,
            headers: { cookie, 'x-csrf-token': csrfToken, ...MULTIPART },
            payload: upload(true),
        });
        expect(response.statusCode).toBe(502);
        expect(response.json().code).toBe('internal');
    });

    it('has nothing to queue when the owner sent no file', async () => {
        const app = await buildApp(env, records);
        const { cookie, csrfToken } = await signIn(app);
        const response = await app.inject({
            method: 'POST',
            url: `/v1/games/${GAME_ID}/versions`,
            headers: { cookie, 'x-csrf-token': csrfToken, ...MULTIPART },
            payload: upload(false),
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('invalid_request');
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
});
