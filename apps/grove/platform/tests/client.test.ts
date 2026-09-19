// The client: what goes on the wire, which refusals are answers rather than throws, and the token
// every write has to carry.

import { describe, expect, it } from 'vitest';
import { ApiError, createApi } from '../src/api/client';
import { ACCOUNT, GAME, PLAYER_ID } from './doubles';

const BASE = 'http://api.test';

interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
    credentials: RequestCredentials | undefined;
}

function recorder(answer: (call: Call) => Response): {
    calls: Call[];
    // `typeof globalThis.fetch`, because a bare `typeof fetch` here names the local below it.
    fetch: typeof globalThis.fetch;
} {
    const calls: Call[] = [];
    const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const call: Call = {
            url: String(input),
            method: init.method ?? 'GET',
            headers: Object.fromEntries(
                Object.entries((init.headers ?? {}) as Record<string, string>),
            ),
            body: typeof init.body === 'string' ? init.body : undefined,
            credentials: init.credentials,
        };
        calls.push(call);
        return answer(call);
    }) as typeof globalThis.fetch;
    return { calls, fetch };
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

const SIGNED_IN = { playerId: PLAYER_ID, csrfToken: 'a-token' };

describe('every call', () => {
    it('sends the cookie, because the API is a different origin', async () => {
        const { calls, fetch } = recorder(() => json(SIGNED_IN));
        await createApi({ baseUrl: BASE, fetch }).session();

        expect(calls[0]?.credentials).toBe('include');
    });

    it('reports an unreachable service apart from one that refused', async () => {
        const fetch = (async () => {
            throw new TypeError('network');
        }) as typeof globalThis.fetch;

        await expect(createApi({ baseUrl: BASE, fetch }).me()).rejects.toMatchObject({
            code: 'unreachable',
            status: 0,
        });
    });

    it('carries the refusal the service wrote rather than one named after the status', async () => {
        const { fetch } = recorder(() =>
            json({ code: 'conflict', message: 'that address already has an account' }, 409),
        );

        await expect(
            createApi({ baseUrl: BASE, fetch }).signUp('a@b.test', 'a-long-password', 'A'),
        ).rejects.toMatchObject({ code: 'conflict', status: 409 });
    });

    it('names a refusal after its status when the body was not one', async () => {
        const { fetch } = recorder(() => new Response('<html>502</html>', { status: 502 }));
        const failure = await createApi({ baseUrl: BASE, fetch })
            .games()
            .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ApiError);
        expect((failure as ApiError).code).toBe('internal');
    });
});

describe('the CSRF token', () => {
    /**
     * Every write but a sign-in carries it, and the client is the one place it lives: a component
     * that had to carry it from the sign-in to the next write is one that can drop it.
     */
    it('is kept from the sign-in and sent on the next write', async () => {
        const { calls, fetch } = recorder((call) =>
            call.url.endsWith('/v1/games') ? json(GAME) : json(SIGNED_IN),
        );
        const api = createApi({ baseUrl: BASE, fetch });

        expect(calls).toHaveLength(0);
        await api.signIn(ACCOUNT.email, 'a-long-enough-password');
        await api.createGame('Lantern Run');

        expect(calls[0]?.headers['x-csrf-token']).toBeUndefined();
        expect(calls[1]?.headers['x-csrf-token']).toBe('a-token');
    });

    it('is dropped on the way out, so a stale one is never presented', async () => {
        const { calls, fetch } = recorder((call) =>
            call.method === 'DELETE' ? new Response(null, { status: 204 }) : json(SIGNED_IN),
        );
        const api = createApi({ baseUrl: BASE, fetch });

        await api.signIn(ACCOUNT.email, 'a-long-enough-password');
        await api.signOut();
        await api.session();

        expect(calls.at(-1)?.headers['x-csrf-token']).toBeUndefined();
    });
});

describe('the refusals that are answers', () => {
    it('reads a cookie naming nobody as nobody rather than as a failure', async () => {
        const { fetch } = recorder(() => json({ code: 'unauthorized', message: 'no' }, 401));

        await expect(createApi({ baseUrl: BASE, fetch }).session()).resolves.toBeUndefined();
    });

    it('reads a refused credential as nobody rather than as a failure', async () => {
        const { fetch } = recorder(() => json({ code: 'unauthorized', message: 'no' }, 401));

        await expect(
            createApi({ baseUrl: BASE, fetch }).signIn('a@b.test', 'nope'),
        ).resolves.toBeUndefined();
    });

    it('reads a spent reset key as false', async () => {
        const { fetch } = recorder(() => json({ code: 'unauthorized', message: 'no' }, 401));

        await expect(
            createApi({ baseUrl: BASE, fetch }).resetPassword('spent', 'a-long-password'),
        ).resolves.toBe(false);
    });

    it('reads a wrong current password as nobody rather than as a failure', async () => {
        const { fetch } = recorder(() => json({ code: 'forbidden', message: 'wrong' }, 403));

        await expect(
            createApi({ baseUrl: BASE, fetch }).changePassword('wrong', 'a-long-password'),
        ).resolves.toBeUndefined();
    });
});

describe('what the routes are sent', () => {
    it('closes an account with the password in the body of the delete', async () => {
        const { calls, fetch } = recorder(() => new Response(null, { status: 204 }));
        await createApi({ baseUrl: BASE, fetch }).closeAccount('a-long-enough-password');

        expect(calls[0]?.method).toBe('DELETE');
        expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
            currentPassword: 'a-long-enough-password',
        });
    });

    it('parses the account it is handed rather than trusting the shape', async () => {
        const { fetch } = recorder(() => json({ playerId: PLAYER_ID, email: 'not-an-account' }));

        await expect(createApi({ baseUrl: BASE, fetch }).me()).rejects.toThrow();
    });
});
