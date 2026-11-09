import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import {
    AssetMediaType,
    MAX_ASSET_BYTES,
    MAX_SOURCE_BYTES,
    MAX_WORKSPACE_FILES,
    encodeManifest,
    manifestKey,
    objectKey,
    uploadKey,
    type AssetUpload,
    type GameId,
    type PlayerId,
    type VersionId,
    type WorkspaceFile,
    type WorkspacePath,
    type WorkspaceSave,
} from '@grove/api-contract';
import { announce, type TaskQueue } from '../queue.js';
import type { FileUpsert, WorkspaceRecord, Workspaces } from '../records.js';
import type { ObjectStream, Storage } from '../storage.js';

/** What a manifest is stored as, which is what @grove/game-builder fetches and parses. */
const MANIFEST_TYPE = 'application/json';

export interface SaveDeps {
    workspaces: Workspaces;
    storage: Storage;
    queue: TaskQueue;
    log: FastifyBaseLogger;
}

export type Saved =
    | { outcome: 'saved'; workspace: WorkspaceRecord }
    | { outcome: 'stale'; revision: number }
    | { outcome: 'missing' }
    | { outcome: 'too_many' }
    | { outcome: 'too_large'; path: WorkspacePath }
    | { outcome: 'not_uploaded'; path: WorkspacePath }
    | { outcome: 'unacceptable'; path: WorkspacePath }
    | { outcome: 'unattached' }
    | { outcome: 'unstored'; path: string };

interface Written {
    key: string;
    versionId: VersionId;
}

/** Stores every byte, manifest included, before one transaction claims the revision. */
export async function saveWorkspace(
    deps: SaveDeps,
    game: GameId,
    account: PlayerId,
    save: WorkspaceSave,
): Promise<Saved> {
    const { workspaces, storage } = deps;
    const current = await workspaces.workspaceOf(game);
    if (current === undefined) return { outcome: 'missing' };
    // Refused before a byte is written: a save that already lost has nothing to clean up.
    if (current.revision !== save.baseRevision) {
        return { outcome: 'stale', revision: current.revision };
    }

    const held = new Map(current.files.map((file) => [file.path as string, file]));
    const kept = current.files.filter((file) => !save.deletes.includes(file.path)).length;
    const added = [...save.sources.map((file) => file.path), ...save.assets].filter(
        (path) => !held.has(path),
    ).length;
    if (kept + added > MAX_WORKSPACE_FILES) return { outcome: 'too_many' };

    const oversized = save.sources.find(
        (source) => Buffer.byteLength(source.text, 'utf8') > MAX_SOURCE_BYTES,
    );
    if (oversized !== undefined) return { outcome: 'too_large', path: oversized.path };

    // An asset's bytes never pass through here, so what landed is read from the bucket instead.
    const landings = await Promise.all(
        save.assets.map(async (path) => ({
            path,
            landed: await storage.head(uploadKey(game, path)),
        })),
    );
    const assets: FileUpsert[] = [];
    for (const { path, landed } of landings) {
        if (landed === undefined) return { outcome: 'not_uploaded', path };
        if (landed.byteLength > MAX_ASSET_BYTES) return { outcome: 'too_large', path };
        const type = AssetMediaType.safeParse(mediaTypeOf(landed.contentType));
        if (!type.success) return { outcome: 'unacceptable', path };
        // The upload the row already names is no change, and inspecting it again would be waste.
        const before = held.get(path);
        if (before?.kind === 'asset' && before.versionId === landed.versionId) continue;
        assets.push({
            path,
            kind: 'asset',
            versionId: landed.versionId,
            byteLength: landed.byteLength,
            contentType: type.data,
        });
    }

    const written: Written[] = [];
    const takeBack = async (): Promise<void> => {
        // By version, so the version a race's winner wrote is current at each key again.
        await Promise.all(written.map(async (each) => storage.discard(each.key, each.versionId)));
    };

    const sources = await Promise.all(
        save.sources.map(async (source) => {
            const key = objectKey(game, 'source', source.path);
            const stored = await storage.put(
                key,
                Buffer.from(source.text, 'utf8'),
                source.contentType,
            );
            if (stored.outcome === 'written') {
                written.push({ key, versionId: stored.version.versionId });
            }
            return { source, stored };
        }),
    );
    const refused = sources.find(({ stored }) => stored.outcome !== 'written');
    if (refused !== undefined) {
        await takeBack();
        return refused.stored.outcome === 'unattached'
            ? { outcome: 'unattached' }
            : { outcome: 'unstored', path: refused.source.path };
    }
    const upserts: FileUpsert[] = [];
    for (const { source, stored } of sources) {
        if (stored.outcome !== 'written') continue;
        upserts.push({
            path: source.path,
            kind: 'source',
            versionId: stored.version.versionId,
            byteLength: stored.version.byteLength,
            contentType: source.contentType,
        });
    }
    upserts.push(...assets);

    const revision = save.baseRevision + 1;
    const saveId = randomUUID();
    const frozen = frozenSet(current.files, upserts, save.deletes);
    const key = manifestKey(game, revision, saveId);
    const manifest = await storage.put(
        key,
        Buffer.from(encodeManifest({ gameId: game, revision, files: frozen }), 'utf8'),
        MANIFEST_TYPE,
    );
    if (manifest.outcome !== 'written') {
        await takeBack();
        return manifest.outcome === 'unattached'
            ? { outcome: 'unattached' }
            : { outcome: 'unstored', path: 'the manifest' };
    }
    written.push({ key, versionId: manifest.version.versionId });

    const saved = await workspaces.saveWorkspace(game, {
        baseRevision: save.baseRevision,
        saveId,
        accountId: account,
        upserts,
        deletes: save.deletes,
        frozen,
    });
    if (saved.outcome !== 'saved') {
        await takeBack();
        return saved.outcome === 'missing'
            ? saved
            : { outcome: 'stale', revision: saved.workspace.revision };
    }

    // After the commit, never before: a delete issued for a lost save would take the winner's file.
    await Promise.all(
        departed(current.files, upserts, save.deletes).map(async (gone) =>
            storage.remove(objectKey(game, gone.kind, gone.path)),
        ),
    );
    await announce(deps.queue, saved.tasks, deps.log);
    return { outcome: 'saved', workspace: saved.workspace };
}

/** The set this save leaves the game holding, in path order, which is what its manifest freezes. */
function frozenSet(
    files: readonly WorkspaceFile[],
    upserts: readonly FileUpsert[],
    deletes: readonly WorkspacePath[],
): WorkspaceFile[] {
    const replaced = new Set<string>([...deletes, ...upserts.map((file) => file.path)]);
    return [...files.filter((file) => !replaced.has(file.path)), ...upserts].toSorted(
        (left, right) => (left.path < right.path ? -1 : 1),
    );
}

/** The keys a save stops naming: a deleted path, or one whose bytes moved to the other class. */
function departed(
    files: readonly WorkspaceFile[],
    upserts: readonly FileUpsert[],
    deletes: readonly WorkspacePath[],
): { path: WorkspacePath; kind: WorkspaceFile['kind'] }[] {
    const kindNow = new Map(upserts.map((file) => [file.path as string, file.kind]));
    return files
        .filter(
            (file) =>
                deletes.includes(file.path) || (kindNow.get(file.path) ?? file.kind) !== file.kind,
        )
        .map((file) => ({ path: file.path, kind: file.kind }));
}

/** Parameters dropped: some stacks answer `image/png; charset=binary` for an `image/png` PUT. */
function mediaTypeOf(header: string): string {
    return header.split(';')[0]?.trim().toLowerCase() ?? '';
}

export interface ReadDeps {
    workspaces: Workspaces;
    storage: Storage;
}

/** One file at the version the rows name: an inspected asset's edge copy, else its upload. */
export async function readFile(
    { workspaces, storage }: ReadDeps,
    game: GameId,
    path: WorkspacePath,
): Promise<ObjectStream | undefined> {
    const file = await workspaces.fileOf(game, path);
    if (file === undefined) return undefined;
    if (file.kind === 'source')
        return storage.open(objectKey(game, 'source', path), file.versionId);
    return file.edgeVersionId === undefined
        ? storage.open(uploadKey(game, path), file.versionId)
        : storage.open(objectKey(game, 'asset', path), file.edgeVersionId);
}

export type UploadRequested =
    | { outcome: 'signed'; upload: AssetUpload }
    | { outcome: 'too_large' }
    | { outcome: 'unattached' }
    | { outcome: 'unavailable' };

/** A presigned PUT into quarantine, signed for the type and the length, recording nothing. */
export async function requestUpload(
    storage: Storage,
    ttlS: number,
    game: GameId,
    request: { path: WorkspacePath; contentType: AssetMediaType; byteLength: number },
): Promise<UploadRequested> {
    if (request.byteLength > MAX_ASSET_BYTES) return { outcome: 'too_large' };
    const signed = await storage.presignPut(uploadKey(game, request.path), {
        contentType: request.contentType,
        byteLength: request.byteLength,
        expiresInS: ttlS,
    });
    if (signed.outcome !== 'signed') return signed;
    return {
        outcome: 'signed',
        upload: {
            path: request.path,
            url: signed.url,
            expiresAt: signed.expiresAt,
            maxBytes: MAX_ASSET_BYTES,
            headers: signed.headers,
        },
    };
}
