// The fixtures every suite below drives the platform with: a service that answers out of memory,
// and the account and games it answers about.

import type { Account, Game, GameId, PlayerId, SignedIn } from '@grove/api-contract';
import { ApiError } from '../src/api/client';
import type { Api } from '../src/api/client';

export const PLAYER_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479' as PlayerId;
export const GAME_ID = '9f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f' as GameId;
export const OLDER_GAME_ID = '3b7d9c1a-2e4f-4a6b-9c8d-1e2f3a4b5c6d' as GameId;

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
};

export const OLDER_GAME: Game = {
    gameId: OLDER_GAME_ID,
    ownerId: PLAYER_ID,
    title: 'Acorn Rally',
    visibility: 'private',
    createdAt: '2026-09-02T09:00:00.000Z',
};

export interface FakeApi extends Api {
    account: Account;
    owned: Game[];
    signedIn: boolean;
    /** The address and password this service would take, which is the only pair that signs in. */
    credentials: { email: string; password: string };
    /** Reset keys this service would take, each once. */
    readonly resetKeys: Set<string>;
    /** Every address a reset was asked for, in order. */
    readonly resetsAsked: string[];
}

/**
 * The service, out of memory.
 *
 * It refuses the way the real one does — one answer for every bad credential, a taken address is a
 * conflict, and a wrong current password is a 403 — because those are the branches a form has to
 * put words to.
 */
export function fakeApi(over: Partial<FakeApi> = {}): FakeApi {
    const api: FakeApi = {
        account: ACCOUNT,
        owned: [GAME, OLDER_GAME],
        signedIn: false,
        credentials: { email: ACCOUNT.email, password: 'a-long-enough-password' },
        resetKeys: new Set(),
        resetsAsked: [],

        session: async () => (api.signedIn ? signedIn() : undefined),

        signIn: async (email, password) => {
            // One answer for an unknown address, a wrong password and a locked account, the way the
            // service gives one.
            if (email !== api.credentials.email || password !== api.credentials.password) {
                return undefined;
            }
            api.signedIn = true;
            return signedIn();
        },

        signUp: async (email, password, displayName) => {
            if (email === api.credentials.email) {
                throw new ApiError(409, 'conflict', 'that address already has an account');
            }
            if (password.length < 8) {
                throw new ApiError(400, 'invalid_request', 'password is 8 to 128 characters');
            }
            api.account = { ...api.account, email, displayName };
            api.credentials = { email, password };
            api.owned = [];
            api.signedIn = true;
            return signedIn();
        },

        signOut: async () => {
            api.signedIn = false;
        },

        requestPasswordReset: async (email) => {
            api.resetsAsked.push(email);
        },

        resetPassword: async (token, newPassword) => {
            // Spent in the step that finds it, the way the real store does.
            if (!api.resetKeys.delete(token)) return false;
            api.credentials = { ...api.credentials, password: newPassword };
            api.signedIn = false;
            return true;
        },

        me: async () => guard(api, api.account),
        games: async () => guard(api, api.owned),

        rename: async (displayName) => {
            guard(api, undefined);
            api.account = { ...api.account, displayName };
            return api.account;
        },

        changePassword: async (currentPassword, newPassword) => {
            guard(api, undefined);
            if (currentPassword !== api.credentials.password) return undefined;
            api.credentials = { ...api.credentials, password: newPassword };
            return signedIn();
        },

        closeAccount: async (currentPassword) => {
            guard(api, undefined);
            if (currentPassword !== api.credentials.password) {
                throw new ApiError(403, 'forbidden', 'wrong password');
            }
            if (api.owned.length > 0) {
                throw new ApiError(409, 'conflict', 'delete your games first');
            }
            api.signedIn = false;
        },

        createGame: async (title) => {
            guard(api, undefined);
            const made: Game = {
                gameId: GAME_ID,
                ownerId: PLAYER_ID,
                title,
                visibility: 'private',
                createdAt: '2026-09-17T09:00:00.000Z',
            };
            api.owned = [made, ...api.owned];
            return made;
        },

        ...over,
    };
    return api;
}

function signedIn(): SignedIn {
    return { playerId: PLAYER_ID, csrfToken: 'a-token' };
}

function guard<T>(api: FakeApi, value: T): T {
    if (!api.signedIn) throw new ApiError(401, 'unauthorized', 'sign in first');
    return value;
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
