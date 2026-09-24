import {
    Account,
    AssetUpload,
    Game,
    Task,
    Workspace,
    type GameId,
    type SignedIn,
    type TaskId,
    type WorkspacePath,
    type WorkspaceSave,
} from '@grove/api-contract';
import { ApiError, apiBaseUrl, createApiBase, isLapsedSession } from '@grove/api-contract/client';
import type { ApiClientOptions } from '@grove/api-contract/client';

export { ApiError, apiBaseUrl, isLapsedSession };

export type ApiOptions = ApiClientOptions;

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

export function createApi(options: ApiOptions): Api {
    const { baseUrl, fetch = globalThis.fetch } = options;
    const base = createApiBase(options);

    return {
        session: async () => base.signedIn(await base.attempt('/v1/auth/session', {}, 401)),

        signOut: async () => {
            await base.call('/v1/auth/sessions/current', { method: 'DELETE' });
            base.forget();
        },

        me: async () => base.read('/v1/players/me', Account),
        games: async () => base.read('/v1/games', Game.array()),
        createGame: async (title) => base.write('/v1/games', 'POST', { title }, Game),

        workspace: async (game) => base.read(`/v1/games/${game}/workspace`, Workspace),

        save: async (game, save) =>
            base.write(`/v1/games/${game}/workspace`, 'PUT', save, Workspace),

        saveOnExit: async (game, save) => {
            // Deliberately unchecked: the page is going, and there is nobody left to tell. What
            // this buys is the request leaving at all, which an ordinary one would not.
            await fetch(`${baseUrl}/v1/games/${game}/workspace`, {
                method: 'PUT',
                credentials: 'include',
                keepalive: true,
                headers: { 'content-type': 'application/json', ...base.csrfHeader() },
                body: JSON.stringify(save),
            }).catch(() => undefined);
        },

        file: async (game, path) =>
            new Uint8Array(
                await (await base.call(`/v1/games/${game}/files/${path}`)).arrayBuffer(),
            ),

        assetUpload: async (game, path, contentType) =>
            base.write(`/v1/games/${game}/assets`, 'POST', { path, contentType }, AssetUpload),

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

        publish: async (game) => base.write(`/v1/games/${game}/versions`, 'POST', undefined, Task),
        task: async (game, task) => base.read(`/v1/games/${game}/tasks/${task}`, Task),
    };
}
