import { Account, Game, SignedIn } from '@grove/api-contract';
import {
    ApiError,
    apiBaseUrl,
    createApiBase,
    isLapsedSession,
    jsonBody,
} from '@grove/api-contract/client';
import type { ApiClientOptions } from '@grove/api-contract/client';

export { ApiError, apiBaseUrl, isLapsedSession };

export type ApiOptions = ApiClientOptions;

/**
 * The @grove/api client the platform holds.
 *
 * This is the one Grove origin a password is typed on, so every credential route lives here and
 * nowhere else. It keeps the CSRF token the last sign-in handed out, because every write has to
 * carry it and a component that had to remember would be one that could forget. The cookie is the
 * browser's, which is why every call is `credentials: 'include'` — the API is a different origin.
 */
export interface Api {
    /** The current session, or nothing at all when the cookie names nobody. */
    session(): Promise<SignedIn | undefined>;
    /** `undefined` is the service's one answer to a wrong address, a wrong password and a lockout. */
    signIn(email: string, password: string): Promise<SignedIn | undefined>;
    signUp(email: string, password: string, displayName: string): Promise<SignedIn>;
    signOut(): Promise<void>;

    /** Asks for a reset mail. It answers the same way whether or not the address has an account. */
    requestPasswordReset(email: string): Promise<void>;
    /** `false` is a key that opens nothing — wrong, already spent, or expired. */
    resetPassword(token: string, newPassword: string): Promise<boolean>;

    me(): Promise<Account>;
    rename(displayName: string): Promise<Account>;
    /** `undefined` is the wrong current password, which is a field to correct rather than an error. */
    changePassword(currentPassword: string, newPassword: string): Promise<SignedIn | undefined>;
    closeAccount(currentPassword: string): Promise<void>;

    games(): Promise<Game[]>;
    createGame(title: string): Promise<Game>;
}

export function createApi(options: ApiOptions): Api {
    const base = createApiBase(options);

    return {
        session: async () => base.signedIn(await base.attempt('/v1/auth/session', {}, 401)),

        signIn: async (email, password) =>
            base.signedIn(
                await base.attempt(
                    '/v1/auth/sessions',
                    { method: 'POST', ...jsonBody({ email, password }) },
                    401,
                ),
            ),

        signUp: async (email, password, displayName) =>
            base.keep(
                await base.write('/v1/players', 'POST', { email, password, displayName }, SignedIn),
            ),

        signOut: async () => {
            await base.call('/v1/auth/sessions/current', { method: 'DELETE' });
            base.forget();
        },

        requestPasswordReset: async (email) => {
            await base.call('/v1/auth/password-resets', { method: 'POST', ...jsonBody({ email }) });
        },

        resetPassword: async (token, newPassword) =>
            (await base.attempt(
                '/v1/auth/password',
                { method: 'PUT', ...jsonBody({ token, newPassword }) },
                401,
            )) !== undefined,

        me: async () => base.read('/v1/players/me', Account),
        rename: async (displayName) =>
            base.write('/v1/players/me', 'PATCH', { displayName }, Account),

        changePassword: async (currentPassword, newPassword) =>
            base.signedIn(
                await base.attempt(
                    '/v1/players/me/password',
                    { method: 'PUT', ...jsonBody({ currentPassword, newPassword }) },
                    403,
                ),
            ),

        closeAccount: async (currentPassword) => {
            await base.call('/v1/players/me', {
                method: 'DELETE',
                ...jsonBody({ currentPassword }),
            });
            base.forget();
        },

        games: async () => base.read('/v1/games', Game.array()),
        createGame: async (title) => base.write('/v1/games', 'POST', { title }, Game),
    };
}
