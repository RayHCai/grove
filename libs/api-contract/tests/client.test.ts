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
