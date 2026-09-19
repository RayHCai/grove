import { Account, ErrorBody, Game, SignedIn } from '@grove/api-contract';

/** A refusal the service named, kept apart from a network failure, which names nothing. */
export class ApiError extends Error {
    readonly code: ErrorBody['code'] | 'unreachable';
    readonly status: number;

    constructor(status: number, code: ApiError['code'], message: string) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
    }
}

export interface ApiOptions {
    baseUrl: string;
    /** Injected so a test drives the client without a server; the browser's own by default. */
    fetch?: typeof globalThis.fetch;
}

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

/** Where the API is, which a build is told and a dev server defaults for. */
export function apiBaseUrl(): string {
    return import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
}

export function createApi({ baseUrl, fetch = globalThis.fetch }: ApiOptions): Api {
    // Held here rather than in a component: it is minted by a sign-in and demanded by every write,
    // and a component that had to carry it between the two is one that can drop it.
    let csrfToken: string | undefined;

    async function send(path: string, init: RequestInit = {}): Promise<Response> {
        const response = await fetch(`${baseUrl}${path}`, {
            ...init,
            // The API is a different origin and the session is a cookie: without this the browser
            // sends nothing and every route behind the gate answers as though nobody signed in.
            credentials: 'include',
            headers: {
                ...init.headers,
                ...(csrfToken === undefined ? {} : { 'x-csrf-token': csrfToken }),
            },
        }).catch(() => undefined);

        if (response === undefined) {
            throw new ApiError(0, 'unreachable', 'the Grove API could not be reached');
        }
        return response;
    }

    async function call(path: string, init: RequestInit = {}): Promise<Response> {
        const response = await send(path, init);
        if (!response.ok) throw await refusal(response);
        return response;
    }

    /**
     * A call whose refusal is an answer rather than a failure.
     *
     * Wrong credentials, a spent reset key and a cookie naming nobody are what a form reports
     * beside its own fields, so each comes back as a status the caller branches on instead of as
     * something thrown past it.
     */
    async function attempt(
        path: string,
        init: RequestInit,
        refused: number,
    ): Promise<Response | undefined> {
        const response = await send(path, init);
        if (response.status === refused) return undefined;
        if (!response.ok) throw await refusal(response);
        return response;
    }

    async function read<T>(path: string, shape: { parse: (value: unknown) => T }): Promise<T> {
        return shape.parse(await (await call(path)).json());
    }

    async function write<T>(
        path: string,
        method: string,
        body: unknown,
        shape: { parse: (value: unknown) => T },
    ): Promise<T> {
        const response = await call(path, { method, ...(body === undefined ? {} : json(body)) });
        return shape.parse(await response.json());
    }

    /** Every route that mints a session hands back the token the next write must carry. */
    function keep(minted: SignedIn): SignedIn {
        csrfToken = minted.csrfToken;
        return minted;
    }

    /** The session a route minted, or nothing where the refusal was the answer. */
    async function signedIn(response: Response | undefined): Promise<SignedIn | undefined> {
        if (response === undefined) return undefined;
        return keep(SignedIn.parse(await response.json()));
    }

    return {
        session: async () => signedIn(await attempt('/v1/auth/session', {}, 401)),

        signIn: async (email, password) =>
            signedIn(
                await attempt(
                    '/v1/auth/sessions',
                    { method: 'POST', ...json({ email, password }) },
                    401,
                ),
            ),

        signUp: async (email, password, displayName) =>
            keep(await write('/v1/players', 'POST', { email, password, displayName }, SignedIn)),

        signOut: async () => {
            await call('/v1/auth/sessions/current', { method: 'DELETE' });
            csrfToken = undefined;
        },

        requestPasswordReset: async (email) => {
            await call('/v1/auth/password-resets', { method: 'POST', ...json({ email }) });
        },

        resetPassword: async (token, newPassword) =>
            (await attempt(
                '/v1/auth/password',
                { method: 'PUT', ...json({ token, newPassword }) },
                401,
            )) !== undefined,

        me: async () => read('/v1/players/me', Account),
        rename: async (displayName) => write('/v1/players/me', 'PATCH', { displayName }, Account),

        changePassword: async (currentPassword, newPassword) =>
            signedIn(
                await attempt(
                    '/v1/players/me/password',
                    { method: 'PUT', ...json({ currentPassword, newPassword }) },
                    403,
                ),
            ),

        closeAccount: async (currentPassword) => {
            await call('/v1/players/me', { method: 'DELETE', ...json({ currentPassword }) });
            csrfToken = undefined;
        },

        games: async () => read('/v1/games', Game.array()),
        createGame: async (title) => write('/v1/games', 'POST', { title }, Game),
    };
}

/** A JSON body and the one header that makes the service parse it as one. */
function json(body: unknown): RequestInit {
    return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** The refusal the service wrote, or one named after the status when the body was not one. */
async function refusal(response: Response): Promise<ApiError> {
    const body = await response
        .json()
        .then((value: unknown) => ErrorBody.safeParse(value))
        .catch(() => undefined);
    return body?.success === true
        ? new ApiError(response.status, body.data.code, body.data.message)
        : new ApiError(response.status, 'internal', `the API answered ${String(response.status)}`);
}
