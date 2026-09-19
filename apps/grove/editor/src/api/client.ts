import {
    Account,
    AssetUpload,
    ErrorBody,
    Game,
    SignedIn,
    Task,
    Workspace,
    type GameId,
    type TaskId,
    type WorkspacePath,
    type WorkspaceSave,
} from '@grove/api-contract';

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
 * The @grove/api client the editor holds.
 *
 * It keeps the CSRF token the session read handed back, because every write has to carry it and a
 * component that had to remember would be one that could forget. The cookie itself is never
 * touched: it is `HttpOnly` and belongs to the API origin, and `credentials: 'include'` is the
 * whole of what makes the browser carry it across from this one.
 */
export interface Api {
    /** The current session, or nothing at all when the cookie names nobody. */
    session(): Promise<SignedIn | undefined>;
    signOut(): Promise<void>;

    me(): Promise<Account>;
    games(): Promise<Game[]>;
    createGame(title: string): Promise<Game>;

    workspace(game: GameId): Promise<Workspace>;
    save(game: GameId, save: WorkspaceSave): Promise<Workspace>;
    /**
     * Sent with `keepalive`, for the one save a closing tab gets to make.
     *
     * The browser kills an ordinary request as the page goes; a keepalive one outlives it, at the
     * cost of a body ceiling the browser rather than this service sets.
     */
    saveOnExit(game: GameId, save: WorkspaceSave): Promise<void>;
    /** One file's bytes, at the version the saved set names. */
    file(game: GameId, path: WorkspacePath): Promise<Uint8Array>;

    /** Where an asset's bytes should go. Nothing is recorded until a save names the path. */
    assetUpload(game: GameId, path: WorkspacePath, contentType: string): Promise<AssetUpload>;
    /** Straight to the bucket, carrying no cookie and no token: the URL is the whole credential. */
    putAsset(upload: AssetUpload, bytes: Uint8Array, contentType: string): Promise<void>;

    publish(game: GameId): Promise<Task>;
    task(game: GameId, task: TaskId): Promise<Task>;
}

/** Where the API is, which a build is told and a dev server defaults for. */
export function apiBaseUrl(): string {
    return import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
}

export function createApi({ baseUrl, fetch = globalThis.fetch }: ApiOptions): Api {
    // Held here rather than in a component: it arrives with the session read and is demanded by
    // every write, and a component that had to carry it between the two is one that can drop it.
    let csrfToken: string | undefined;

    async function call(path: string, init: RequestInit = {}): Promise<Response> {
        const response = await fetch(`${baseUrl}${path}`, {
            ...init,
            // The API is a different origin, and the session is a cookie: without this the browser
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
        const response = await call(path, {
            method,
            headers: { 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return shape.parse(await response.json());
    }

    /** Every route that answers for a session hands back the token the next write must carry. */
    function keep(signedIn: SignedIn): SignedIn {
        csrfToken = signedIn.csrfToken;
        return signedIn;
    }

    return {
        session: async () => {
            const response = await fetch(`${baseUrl}/v1/auth/session`, {
                credentials: 'include',
            }).catch(() => undefined);
            if (response === undefined) {
                throw new ApiError(0, 'unreachable', 'the Grove API could not be reached');
            }
            // A cookie naming nobody is the ordinary first load, not a failure to report.
            if (response.status === 401) return undefined;
            if (!response.ok) throw await refusal(response);
            return keep(SignedIn.parse(await response.json()));
        },

        signOut: async () => {
            await call('/v1/auth/sessions/current', { method: 'DELETE' });
            csrfToken = undefined;
        },

        me: async () => read('/v1/players/me', Account),
        games: async () => read('/v1/games', Game.array()),
        createGame: async (title) => write('/v1/games', 'POST', { title }, Game),

        workspace: async (game) => read(`/v1/games/${game}/workspace`, Workspace),

        save: async (game, save) => write(`/v1/games/${game}/workspace`, 'PUT', save, Workspace),

        saveOnExit: async (game, save) => {
            // Deliberately unchecked: the page is going, and there is nobody left to tell. What
            // this buys is the request leaving at all, which an ordinary one would not.
            await fetch(`${baseUrl}/v1/games/${game}/workspace`, {
                method: 'PUT',
                credentials: 'include',
                keepalive: true,
                headers: {
                    'content-type': 'application/json',
                    ...(csrfToken === undefined ? {} : { 'x-csrf-token': csrfToken }),
                },
                body: JSON.stringify(save),
            }).catch(() => undefined);
        },

        file: async (game, path) =>
            new Uint8Array(await (await call(`/v1/games/${game}/files/${path}`)).arrayBuffer()),

        assetUpload: async (game, path, contentType) =>
            write(`/v1/games/${game}/assets`, 'POST', { path, contentType }, AssetUpload),

        putAsset: async (upload, bytes, contentType) => {
            const response = await fetch(upload.url, {
                method: 'PUT',
                // No cookie: this is the bucket, not the API, and a credential sent there is a
                // credential handed to a third party.
                headers: { 'content-type': contentType },
                // Copied into a plain ArrayBuffer view: a Uint8Array over a SharedArrayBuffer is
                // not a body `fetch` will take.
                body: new Uint8Array(bytes),
            }).catch(() => undefined);

            if (response === undefined || !response.ok) {
                throw new ApiError(
                    response?.status ?? 0,
                    'internal',
                    `${upload.path} could not be uploaded`,
                );
            }
        },

        publish: async (game) => write(`/v1/games/${game}/versions`, 'POST', undefined, Task),
        task: async (game, task) => read(`/v1/games/${game}/tasks/${task}`, Task),
    };
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
