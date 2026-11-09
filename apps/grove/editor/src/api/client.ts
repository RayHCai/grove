import {
    Account,
    AssetUpload,
    Game,
    Workspace,
    type GameId,
    type SignedIn,
    type WorkspacePath,
    type WorkspaceSave,
} from '@grove/api-contract';
import { ApiError, createApiBase, isLapsedSession } from '@grove/api-contract/client';
import type { ApiClientOptions } from '@grove/api-contract/client';

export { ApiError, isLapsedSession };

export type ApiOptions = ApiClientOptions;

/** The most a keepalive request may carry; the browser refuses a larger one before it leaves. */
export const KEEPALIVE_BYTES = 64 * 1024;

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

    me(): Promise<Account>;
    games(): Promise<Game[]>;
    createGame(title: string): Promise<Game>;

    workspace(game: GameId): Promise<Workspace>;
    save(game: GameId, save: WorkspaceSave): Promise<Workspace>;
    /** The one save a closing tab gets: `keepalive`, and what it landed as for a tab that stayed. */
    saveOnExit(game: GameId, save: WorkspaceSave): Promise<Workspace | undefined>;
    /** One file's bytes, at the version the saved set names. */
    file(game: GameId, path: WorkspacePath): Promise<Uint8Array>;

    /** Where an asset's bytes should go. Nothing is recorded until a save names the path. */
    assetUpload(
        game: GameId,
        path: WorkspacePath,
        declared: { contentType: string; byteLength: number },
    ): Promise<AssetUpload>;
    /** Straight to the bucket, carrying no cookie and no token: the URL is the whole credential. */
    putAsset(upload: AssetUpload, bytes: Uint8Array): Promise<void>;
}

export function createApi(options: ApiOptions): Api {
    const { fetch = globalThis.fetch } = options;
    const base = createApiBase(options);

    async function exitSave(game: GameId, body: string, keepalive: boolean): Promise<Workspace> {
        const response = await base.call(`/v1/games/${encodeURIComponent(game)}/workspace`, {
            method: 'PUT',
            keepalive,
            headers: { 'content-type': 'application/json' },
            body,
        });
        return Workspace.parse(await response.json());
    }

    return {
        session: async () => base.signedIn(await base.attempt('/v1/auth/session', {}, 401)),

        me: async () => base.read('/v1/players/me', Account),
        games: async () => base.read('/v1/games', Game.array()),
        createGame: async (title) => base.write('/v1/games', 'POST', { title }, Game),

        workspace: async (game) =>
            base.read(`/v1/games/${encodeURIComponent(game)}/workspace`, Workspace),

        save: async (game, save) =>
            base.write(`/v1/games/${encodeURIComponent(game)}/workspace`, 'PUT', save, Workspace),

        saveOnExit: async (game, save) => {
            const body = JSON.stringify(save);
            const fits = new TextEncoder().encode(body).byteLength <= KEEPALIVE_BYTES;
            const unsent = new ApiError(0, 'unreachable', 'too large to keep alive');
            // An ordinary request still lands for a tab that was only hidden, which is the best
            // left for a body the browser would refuse to keep alive, or one it did refuse.
            return (fits ? exitSave(game, body, true) : Promise.reject(unsent))
                .catch(async (failure: unknown) => {
                    if (failure instanceof ApiError && failure.code === 'unreachable') {
                        return exitSave(game, body, false);
                    }
                    throw failure;
                })
                .catch(() => undefined);
        },

        file: async (game, path) =>
            new Uint8Array(
                await (
                    await base.call(`/v1/games/${encodeURIComponent(game)}/files/${path}`)
                ).arrayBuffer(),
            ),

        assetUpload: async (game, path, { contentType, byteLength }) =>
            base.write(
                `/v1/games/${encodeURIComponent(game)}/assets`,
                'POST',
                { path, contentType, byteLength },
                AssetUpload,
            ),

        putAsset: async (upload, bytes) => {
            const response = await fetch(upload.url, {
                method: 'PUT',
                // Exactly what was signed and nothing else: no cookie, since this is the bucket and
                // a credential sent there is handed to a third party.
                headers: upload.headers,
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
    };
}
