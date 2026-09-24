import {
    BuildArtifact,
    Manifest,
    REQUEST_ID_HEADER,
    type GameId,
    type WorkspacePath,
} from '@grove/api-contract';
import type { Env } from './env.js';

/** `missing` is an answer — a revision nothing froze — where `unavailable` is the fleet failing. */
export type Fetched<T> =
    { outcome: 'found'; value: T } | { outcome: 'missing' } | { outcome: 'unavailable' };

export type Stored = { outcome: 'stored'; artifact: BuildArtifact } | { outcome: 'unavailable' };

/**
 * Where a build reads the source it was told to compile and writes what came out.
 *
 * Through @grove/api rather than the bucket, which is the reason this process holds no bucket
 * credential: what it may read is one frozen manifest's files at the versions that manifest named,
 * and what it may write is the prefix its own revision owns. Neither is a key this box composes.
 */
export interface BuildStore {
    manifest(game: GameId, revision: number, requestId: string): Promise<Fetched<Manifest>>;
    /** One file's bytes, at the version the manifest froze — never whatever is current at the key. */
    file(
        game: GameId,
        revision: number,
        path: WorkspacePath,
        requestId: string,
    ): Promise<Fetched<Buffer>>;
    store(
        game: GameId,
        revision: number,
        name: string,
        body: Buffer,
        contentType: string,
        requestId: string,
    ): Promise<Stored>;
}

/** A source file is a script and a chunk is a few hundred kilobytes; neither is a slow transfer. */
const TRANSFER_TIMEOUT_MS = 30_000;

/** Every route below hangs off one revision of one game, which is the whole of what a build sees. */
function revisionPath(game: GameId, revision: number): string {
    return `/v1/fleet/games/${game}/revisions/${String(revision)}`;
}

export function httpStore(env: Env): BuildStore {
    const call = async (
        path: string,
        requestId: string,
        init: RequestInit = {},
    ): Promise<Response | undefined> =>
        fetch(`${env.API_URL}${path}`, {
            ...init,
            headers: {
                ...init.headers,
                authorization: `Bearer ${env.FLEET_SECRET}`,
                [REQUEST_ID_HEADER]: requestId,
            },
            signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
        }).catch(() => undefined);

    return {
        manifest: async (game, revision, requestId) => {
            const answered = await call(`${revisionPath(game, revision)}/manifest`, requestId);
            if (answered === undefined) return { outcome: 'unavailable' };
            if (answered.status === 404) return { outcome: 'missing' };
            if (!answered.ok) return { outcome: 'unavailable' };

            // Parsed rather than cast: this decides which bytes are compiled, and a manifest that
            // does not parse is one nothing should be built from.
            const parsed = Manifest.safeParse(await answered.json().catch(() => undefined));
            return parsed.success
                ? { outcome: 'found', value: parsed.data }
                : { outcome: 'unavailable' };
        },

        file: async (game, revision, path, requestId) => {
            const answered = await call(`${revisionPath(game, revision)}/files/${path}`, requestId);
            if (answered === undefined) return { outcome: 'unavailable' };
            if (answered.status === 404) return { outcome: 'missing' };
            if (!answered.ok) return { outcome: 'unavailable' };

            const bytes = await answered.arrayBuffer().catch(() => undefined);
            return bytes === undefined
                ? { outcome: 'unavailable' }
                : { outcome: 'found', value: Buffer.from(bytes) };
        },

        store: async (game, revision, name, body, contentType, requestId) => {
            const answered = await call(
                `${revisionPath(game, revision)}/build/${name}`,
                requestId,
                {
                    method: 'PUT',
                    headers: { 'content-type': contentType },
                    body: new Uint8Array(body),
                },
            );
            if (answered === undefined || !answered.ok) return { outcome: 'unavailable' };

            const parsed = BuildArtifact.safeParse(await answered.json().catch(() => undefined));
            // The address and the digest are the service's answer, and a build manifest naming
            // neither is one the allocator would hand a player.
            return parsed.success
                ? { outcome: 'stored', artifact: parsed.data }
                : { outcome: 'unavailable' };
        },
    };
}
