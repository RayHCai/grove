// The fixtures every suite below drives the platform with: a service that answers out of memory,
// and the account and games it answers about.

import type {
    Account,
    ErrorBody,
    Game,
    GameId,
    PlayerId,
    PlaySession,
    SessionId,
} from '@grove/api-contract';
import { createApi } from '../src/api/client';
import type { Api } from '../src/api/client';

export const PLAYER_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479' as PlayerId;
export const GAME_ID = '9f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f' as GameId;
export const OLDER_GAME_ID = '3b7d9c1a-2e4f-4a6b-9c8d-1e2f3a4b5c6d' as GameId;

/** Where the fake service answers, which nothing outside these suites dials. */
export const API_URL = 'https://api.grove.example';

export const ACCOUNT: Account = {
    playerId: PLAYER_ID,
    email: 'creator@grove.example',
    displayName: 'Rowan',
    createdAt: '2026-09-01T09:00:00.000Z',
};

export const GAME: Game = {
    gameId: GAME_ID,
    ownerId: PLAYER_ID,
    title: "Pip's Garden",
    visibility: 'private',
    createdAt: '2026-09-10T09:00:00.000Z',
    publishedAt: null,
};

export const OLDER_GAME: Game = {
    gameId: OLDER_GAME_ID,
    ownerId: PLAYER_ID,
    title: 'Acorn Rally',
    visibility: 'private',
    createdAt: '2026-09-02T09:00:00.000Z',
    publishedAt: null,
};

/** What the allocator answers a Play with, which the platform hands on without reading. */
export const PLAY_SESSION: PlaySession = {
    sessionId: '5d9a0c3b-7e21-4f44-9b0d-3c5e7a9f1b24' as SessionId,
    serverUrl: 'wss://box.example:41337/play',
    ticket: 'a.signed.ticket',
    expiresAt: '2026-09-19T12:00:00.000Z',
    revision: 7,
    projectId: 'pips-garden',
    projectHash: 'a'.repeat(64),
};

export interface FakeApi extends Api {
    account: Account;
    owned: Game[];
    /** Whether the cookie the browser carries names a live session. */
    signedIn: boolean;
    /** The address and password this service would take, which is the only pair that signs in. */
    credentials: { email: string; password: string };
    /** Reset keys this service would take, each once. */
    readonly resetKeys: Set<string>;
    /** Every address a reset was asked for, in order. */
    readonly resetsAsked: string[];
    /** Games with no finished build, which the allocator refuses as a conflict. */
    readonly unplayable: Set<string>;
    /** The token the live session verifies writes against; every sign-in mints a new one. */
    readonly csrfToken: string;
    /** Every request that reached the service, as `METHOD path`. */
    readonly requests: string[];
    /** A sign-in on another tab: a fresh session, so every token handed out before it is stale. */
    signInElsewhere(): void;
}

interface Call {
    method: string;
    path: string;
    body: Record<string, string> | undefined;
}

// The service out of memory, behind the platform's own client, refusing as the real one does: one
// answer for every bad credential, a taken address, a wrong password, no cookie, and a stale token.
export function fakeApi(over: Partial<FakeApi> = {}): FakeApi {
    let sessions = 1;
    const state = {
        account: ACCOUNT,
        owned: [GAME, OLDER_GAME],
        signedIn: false,
        credentials: { email: ACCOUNT.email, password: 'a-long-enough-password' },
        resetKeys: new Set<string>(),
        resetsAsked: [] as string[],
        unplayable: new Set<string>(),
        csrfToken: 'token-1',
        requests: [] as string[],
        signInElsewhere: () => {
            begin();
        },
    };

    /** A session begins the way the real one does: rotated, with a token nothing before it held. */
    function begin(): Response {
        sessions += 1;
        state.signedIn = true;
        state.csrfToken = `token-${String(sessions)}`;
        return json({ playerId: PLAYER_ID, csrfToken: state.csrfToken });
    }

    /** The routes in front of the session gate: a credential, or a key, and no token to show. */
    function anonymous({ method, path, body }: Call): Response | undefined {
        const said = body ?? {};
        if (method === 'POST' && path === '/v1/auth/sessions') {
            const matches =
                said['email'] === state.credentials.email &&
                said['password'] === state.credentials.password;
            return matches ? begin() : refuse(401, 'unauthorized', 'those do not match an account');
        }
        if (method === 'POST' && path === '/v1/players') {
            if (said['email'] === state.credentials.email) {
                return refuse(409, 'conflict', 'that address already has an account');
            }
            if ((said['password'] ?? '').length < 8) {
                return refuse(400, 'invalid_request', 'password is 8 to 128 characters');
            }
            state.account = {
                ...state.account,
                email: said['email'] ?? '',
                displayName: said['displayName'] ?? '',
            };
            state.credentials = { email: said['email'] ?? '', password: said['password'] ?? '' };
            state.owned = [];
            const minted = begin();
            return new Response(minted.body, { status: 201, headers: minted.headers });
        }
        if (method === 'POST' && path === '/v1/auth/password-resets') {
            state.resetsAsked.push(said['email'] ?? '');
            return new Response(null, { status: 204 });
        }
        if (method === 'PUT' && path === '/v1/auth/password') {
            // Spent in the step that finds it, the way the real store does.
            if (!state.resetKeys.delete(said['token'] ?? '')) {
                return refuse(401, 'unauthorized', 'that key opens nothing');
            }
            state.credentials = { ...state.credentials, password: said['newPassword'] ?? '' };
            state.signedIn = false;
            return new Response(null, { status: 204 });
        }
        return undefined;
    }

    /** The routes behind it, which a cookie naming a live session reaches. */
    function signedIn({ method, path, body }: Call): Response {
        const said = body ?? {};
        if (method === 'GET' && path === '/v1/auth/session') {
            return json({ playerId: PLAYER_ID, csrfToken: state.csrfToken });
        }
        if (method === 'DELETE' && path === '/v1/auth/sessions/current') {
            state.signedIn = false;
            return new Response(null, { status: 204 });
        }
        if (method === 'GET' && path === '/v1/players/me') return json(state.account);
        if (method === 'PATCH' && path === '/v1/players/me') {
            state.account = { ...state.account, displayName: said['displayName'] ?? '' };
            return json(state.account);
        }
        if (method === 'PUT' && path === '/v1/players/me/password') {
            if (said['currentPassword'] !== state.credentials.password) {
                return refuse(403, 'forbidden', 'wrong password');
            }
            state.credentials = { ...state.credentials, password: said['newPassword'] ?? '' };
            return begin();
        }
        if (method === 'DELETE' && path === '/v1/players/me') {
            if (said['currentPassword'] !== state.credentials.password) {
                return refuse(403, 'forbidden', 'wrong password');
            }
            if (state.owned.length > 0) return refuse(409, 'conflict', 'delete your games first');
            state.signedIn = false;
            return new Response(null, { status: 204 });
        }
        if (method === 'GET' && path === '/v1/games') return json(state.owned);
        if (method === 'POST' && path === '/v1/games') {
            const made: Game = {
                gameId: GAME_ID,
                ownerId: PLAYER_ID,
                title: said['title'] ?? '',
                visibility: 'private',
                createdAt: '2026-09-17T09:00:00.000Z',
                publishedAt: null,
            };
            state.owned = [made, ...state.owned];
            return json(made, 201);
        }
        const game = /^\/v1\/games\/([^/]+)(\/play)?$/u.exec(path);
        if (game !== null && method === 'DELETE' && game[2] === undefined) {
            state.owned = state.owned.filter((each) => each.gameId !== game[1]);
            return new Response(null, { status: 204 });
        }
        if (game !== null && method === 'POST' && game[2] === '/play') {
            return state.unplayable.has(game[1] ?? '')
                ? refuse(409, 'conflict', 'no playable build')
                : json(PLAY_SESSION);
        }
        return refuse(404, 'not_found', 'no such route');
    }

    const fetch = async (
        input: string | URL | Request,
        init: RequestInit = {},
    ): Promise<Response> => {
        const url = new URL(String(input));
        if (url.origin !== API_URL) throw new TypeError('Failed to fetch');
        const method = init.method ?? 'GET';
        state.requests.push(`${method} ${url.pathname}`);
        const body =
            typeof init.body === 'string'
                ? (JSON.parse(init.body) as Record<string, string>)
                : undefined;
        const request = { method, path: url.pathname, body };

        const open = anonymous(request);
        if (open !== undefined) return open;
        // Without the cookie the API is a stranger, which is what a call missing `include` is.
        if (init.credentials !== 'include' || !state.signedIn) {
            return refuse(401, 'unauthorized', 'sign in first');
        }
        if (!['GET', 'HEAD'].includes(method)) {
            const token = new Headers(init.headers).get('x-csrf-token');
            if (token !== state.csrfToken) return refuse(403, 'csrf_invalid', 'Invalid csrf token');
        }
        return signedIn(request);
    };

    return Object.assign(state, createApi({ baseUrl: API_URL, fetch }), over) as FakeApi;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function refuse(status: number, code: ErrorBody['code'], message: string): Response {
    return json({ code, message }, status);
}

/** A service somebody is already signed in to, which is the ordinary state of the pages behind it. */
export function signedInApi(over: Partial<FakeApi> = {}): FakeApi {
    return fakeApi({ signedIn: true, ...over });
}

/** Records where the app tried to send the tab, instead of letting jsdom refuse to go. */
export function navigation(): { to: string[]; navigate: (url: string) => void } {
    const to: string[] = [];
    return { to, navigate: (url) => to.push(url) };
}
