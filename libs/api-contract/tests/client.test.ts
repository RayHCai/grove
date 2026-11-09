// The scaffolding @grove/editor and @grove/platform both took a copy of: the CSRF header, the
// credentials, the JSON body, and the one predicate for "did the session lapse".

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError, createApiBase, isLapsedSession } from '../src/client.js';
import type { PlayerId } from '../src/ids.js';

const BASE = 'http://api.test';
const PLAYER_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479' as PlayerId;
const Shape = z.object({ ok: z.boolean() });

interface Sent {
    url: string;
    init: RequestInit | undefined;
}

function stub(...answers: Response[]): { sent: Sent[]; fetch: typeof globalThis.fetch } {
    const sent: Sent[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
        sent.push({ url, init });
        return answers[sent.length - 1] ?? new Response(null, { status: 500 });
    }) as unknown as typeof globalThis.fetch;
    return { sent, fetch };
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function headerOf(sent: Sent | undefined, name: string): string | undefined {
    return (sent?.init?.headers as Record<string, string> | undefined)?.[name];
}

describe('isLapsedSession', () => {
    it('is true for the code the gate writes when a cookie names nobody', () => {
        expect(isLapsedSession(new ApiError(401, 'unauthorized', 'no'))).toBe(true);
    });

    it('is true for a raw 401 that carried no ErrorBody, from whatever sits in front of the gate', () => {
        expect(isLapsedSession(new ApiError(401, 'internal', 'the API answered 401'))).toBe(true);
    });

    it('is false for a 403: an account that is signed in but not allowed is not one that lapsed', () => {
        expect(isLapsedSession(new ApiError(403, 'forbidden', 'not your game'))).toBe(false);
    });

    it('is false for anything that is not this service refusing something', () => {
        expect(isLapsedSession(new Error('boom'))).toBe(false);
        expect(isLapsedSession(undefined)).toBe(false);
    });
});

describe('createApiBase', () => {
    it('sends the cookie, and the CSRF token once one has been kept', async () => {
        const { sent, fetch } = stub(json({ ok: true }), json({ ok: true }));
        const base = createApiBase({ baseUrl: BASE, fetch });

        await base.call('/x');
        expect(sent[0]?.init?.credentials).toBe('include');
        expect(headerOf(sent[0], 'x-csrf-token')).toBeUndefined();

        base.keep({ playerId: PLAYER_ID, csrfToken: 'a-token' });
        await base.call('/y');
        expect(headerOf(sent[1], 'x-csrf-token')).toBe('a-token');
    });

    it('reports an unreachable service apart from one that refused', async () => {
        const fetch = (async () => {
            throw new TypeError('network');
        }) as unknown as typeof globalThis.fetch;
        const base = createApiBase({ baseUrl: BASE, fetch });

        await expect(base.call('/x')).rejects.toMatchObject({ code: 'unreachable', status: 0 });
    });

    it('reads the refusal the service wrote rather than guessing from the status', async () => {
        const { fetch } = stub(json({ code: 'conflict', message: 'taken' }, 409));
        const base = createApiBase({ baseUrl: BASE, fetch });

        await expect(base.call('/x')).rejects.toMatchObject({
            code: 'conflict',
            status: 409,
            message: 'taken',
        });
    });

    it('names a body that was not a refusal after its status', async () => {
        const { fetch } = stub(new Response('<html>502</html>', { status: 502 }));
        const base = createApiBase({ baseUrl: BASE, fetch });

        await expect(base.call('/x')).rejects.toMatchObject({ code: 'internal', status: 502 });
    });

    it('answers a named status as nothing rather than throwing', async () => {
        const { fetch } = stub(new Response(null, { status: 401 }));
        const base = createApiBase({ baseUrl: BASE, fetch });

        await expect(base.attempt('/x', {}, 401)).resolves.toBeUndefined();
    });

    it('still throws from attempt when the refusal is not the one named', async () => {
        const { fetch } = stub(json({ code: 'internal', message: 'oops' }, 500));
        const base = createApiBase({ baseUrl: BASE, fetch });

        await expect(base.attempt('/x', {}, 401)).rejects.toMatchObject({ code: 'internal' });
    });

    it('parses a read through the shape it is given', async () => {
        const { fetch } = stub(json({ ok: true }));
        const base = createApiBase({ baseUrl: BASE, fetch });

        await expect(base.read('/x', Shape)).resolves.toEqual({ ok: true });
    });

    it('writes a body only when there is one', async () => {
        const { sent, fetch } = stub(json({ ok: true }), json({ ok: true }));
        const base = createApiBase({ baseUrl: BASE, fetch });

        await base.write('/x', 'POST', undefined, Shape);
        await base.write('/y', 'POST', { a: 1 }, Shape);

        expect(sent[0]?.init?.body).toBeUndefined();
        expect(sent[1]?.init?.body).toBe(JSON.stringify({ a: 1 }));
    });

    it('keeps and reports the CSRF header for a request built outside call and write', () => {
        const base = createApiBase({ baseUrl: BASE, fetch: stub(json({ ok: true })).fetch });
        expect(base.csrfHeader()).toEqual({});

        base.keep({ playerId: PLAYER_ID, csrfToken: 'a-token' });
        expect(base.csrfHeader()).toEqual({ 'x-csrf-token': 'a-token' });
    });

    it('drops the token on forget, so nothing stale rides the next write', () => {
        const base = createApiBase({ baseUrl: BASE, fetch: stub(json({ ok: true })).fetch });
        base.keep({ playerId: PLAYER_ID, csrfToken: 'a-token' });
        base.forget();
        expect(base.csrfHeader()).toEqual({});
    });

    it('resolves the session a route minted, or nothing where the refusal was the answer', async () => {
        const base = createApiBase({ baseUrl: BASE, fetch: stub().fetch });

        await expect(base.signedIn(undefined)).resolves.toBeUndefined();
        await expect(
            base.signedIn(json({ playerId: PLAYER_ID, csrfToken: 'a-token' })),
        ).resolves.toEqual({ playerId: PLAYER_ID, csrfToken: 'a-token' });
        expect(base.csrfHeader()).toEqual({ 'x-csrf-token': 'a-token' });
    });
});

const tokenOf = (held: number): string => `token-${String(held)}`;

/** A service that pairs each token with the session's secret and rotates the secret on sign-in. */
function service(): {
    fetch: typeof globalThis.fetch;
    sent: { route: string; body: unknown }[];
    signInElsewhere: () => void;
    lapseBeforeTheNextRead: () => void;
    refuseEveryToken: () => void;
} {
    let secret = 1;
    let lapsing = false;
    let refusing = false;
    const sent: { route: string; body: unknown }[] = [];

    const fetch = (async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const path = new URL(url).pathname;
        sent.push({ route: `${method} ${path}`, body: init?.body });
        if (path === '/v1/auth/session') {
            return lapsing
                ? json({ code: 'unauthorized', message: 'sign in first' }, 401)
                : json({ playerId: PLAYER_ID, csrfToken: tokenOf(secret) });
        }
        const presented = (init?.headers as Record<string, string> | undefined)?.['x-csrf-token'];
        if (method !== 'GET' && (refusing || presented !== tokenOf(secret))) {
            return json({ code: 'csrf_invalid', message: 'Invalid csrf token' }, 403);
        }
        if (path === '/mine') return json({ code: 'forbidden', message: 'not your game' }, 403);
        return json({ ok: true });
    }) as unknown as typeof globalThis.fetch;

    return {
        fetch,
        sent,
        signInElsewhere: () => {
            secret += 1;
        },
        lapseBeforeTheNextRead: () => {
            lapsing = true;
        },
        refuseEveryToken: () => {
            refusing = true;
        },
    };
}

describe('a write whose token went stale', () => {
    it('is sent once more under the token a fresh session read hands back', async () => {
        const api = service();
        const base = createApiBase({ baseUrl: BASE, fetch: api.fetch });
        base.keep({ playerId: PLAYER_ID, csrfToken: 'token-1' });
        api.signInElsewhere();

        await expect(base.write('/x', 'POST', { a: 1 }, Shape)).resolves.toEqual({ ok: true });
        expect(api.sent.map((request) => request.route)).toEqual([
            'POST /x',
            'GET /v1/auth/session',
            'POST /x',
        ]);
        expect(api.sent[2]?.body).toBe(api.sent[0]?.body);
        // Kept, so the next write needs no second round trip.
        expect(base.csrfHeader()).toEqual({ 'x-csrf-token': 'token-2' });
    });

    it('re-reads the session once for a burst of writes that all found it stale', async () => {
        const api = service();
        const base = createApiBase({ baseUrl: BASE, fetch: api.fetch });
        base.keep({ playerId: PLAYER_ID, csrfToken: 'token-1' });
        api.signInElsewhere();

        await Promise.all([
            base.write('/x', 'POST', { a: 1 }, Shape),
            base.write('/y', 'PUT', { b: 2 }, Shape),
        ]);
        expect(api.sent.filter((request) => request.route === 'GET /v1/auth/session')).toHaveLength(
            1,
        );
    });

    it('is retried once and no more, so a service that refuses every token cannot loop it', async () => {
        const api = service();
        const base = createApiBase({ baseUrl: BASE, fetch: api.fetch });
        api.refuseEveryToken();

        await expect(base.write('/x', 'POST', { a: 1 }, Shape)).rejects.toMatchObject({
            status: 403,
            code: 'csrf_invalid',
        });
        expect(api.sent).toHaveLength(3);
    });

    it('reports a lapsed session when the re-read finds nobody signed in', async () => {
        const api = service();
        const base = createApiBase({ baseUrl: BASE, fetch: api.fetch });
        base.keep({ playerId: PLAYER_ID, csrfToken: 'token-1' });
        api.signInElsewhere();
        api.lapseBeforeTheNextRead();

        const failure = await base
            .write('/x', 'POST', { a: 1 }, Shape)
            .catch((thrown: unknown) => thrown);
        expect(isLapsedSession(failure)).toBe(true);
        expect(api.sent.map((request) => request.route)).toEqual([
            'POST /x',
            'GET /v1/auth/session',
        ]);
    });

    it('leaves every other 403 alone, which is an account not allowed rather than a stale token', async () => {
        const api = service();
        const base = createApiBase({ baseUrl: BASE, fetch: api.fetch });
        base.keep({ playerId: PLAYER_ID, csrfToken: 'token-1' });

        await expect(base.write('/mine', 'POST', {}, Shape)).rejects.toMatchObject({
            status: 403,
            code: 'forbidden',
        });
        expect(api.sent.map((request) => request.route)).toEqual(['POST /mine']);
    });
});
