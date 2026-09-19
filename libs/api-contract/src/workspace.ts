import { z } from 'zod';
import { BundleSet } from './game-data.js';
import { GameId } from './ids.js';

/**
 * One path in a game's workspace: POSIX, relative, and made only of segments a filesystem, a URL
 * and an archive entry all spell the same way.
 *
 * Refused rather than normalised. A path this service rewrote would name one file to the editor
 * that saved it and another to the builder that reads it back.
 */
export const WorkspacePath = z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u, {
        error: 'a path is slash-separated segments of letters, digits, dot, dash and underscore',
    })
    .refine((path) => !path.split('/').some((segment) => segment === '.' || segment === '..'), {
        error: 'a path cannot carry a . or .. segment',
    });
export type WorkspacePath = z.infer<typeof WorkspacePath>;

/** Carried per file rather than guessed from the extension: what a browser is handed to render it. */
export const MediaType = z
    .string()
    .max(128)
    .regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/u, { error: 'not a media type' });
export type MediaType = z.infer<typeof MediaType>;

/**
 * The version the bucket gave one byte-set of one key.
 *
 * Opaque: the bucket mints it and nothing here may reconstruct it or compare it for anything but
 * equality. Every printable byte is allowed because a version id carries slashes, plus signs and
 * equals signs, and `null` is what a key written before versioning was on comes back as.
 */
export const VersionId = z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[!-~]+$/u, { error: 'not an object version id' });
export type VersionId = z.infer<typeof VersionId>;

/**
 * Which half of a game's storage a path lives in.
 *
 * Not a guess from the media type: an asset takes a presigned upload and a task of its own, and a
 * source rides inline in the save. A manifest carries it because the key behind a file is
 * `<game>/<kind>/<path>` and nothing else in the manifest says which.
 */
export const FileKind = z.enum(['source', 'asset']);
export type FileKind = z.infer<typeof FileKind>;

/** A file is a path and the version of the bytes at it; the bytes themselves are in the bucket. */
export const WorkspaceFile = z.object({
    path: WorkspacePath,
    kind: FileKind,
    versionId: VersionId,
    byteLength: z.int().nonnegative(),
    contentType: MediaType,
});
export type WorkspaceFile = z.infer<typeof WorkspaceFile>;

/** Enough for a game's source and its art, and short enough that one save is one statement. */
export const MAX_WORKSPACE_FILES = 512;

/** What one source file may reach inline in a save body. Anything larger is an asset. */
export const MAX_SOURCE_BYTES = 1024 * 1024;

/** What one asset may reach through its presigned PUT. */
export const MAX_ASSET_BYTES = 32 * 1024 * 1024;

/** No path twice: a set of paths is what a save means, and two rows for one path is not a set. */
const distinctPaths = (files: readonly WorkspaceFile[]): boolean =>
    new Set(files.map((file) => file.path)).size === files.length;

const FileSet = z.array(WorkspaceFile).max(MAX_WORKSPACE_FILES).refine(distinctPaths, {
    error: 'a path may appear once',
});

/**
 * Every file a game holds right now, and the revision that names this exact set.
 *
 * `revision` is 0 for a game nothing has ever saved, which is the state an editor seeds a template
 * into rather than an error it reports.
 */
export const Workspace = z.object({
    gameId: GameId,
    revision: z.int().nonnegative(),
    files: FileSet,
    updatedAt: z.iso.datetime(),
});
export type Workspace = z.infer<typeof Workspace>;

/** A source file as a save carries it: the text itself, because a script is small enough to inline. */
export const SourceUpsert = z.object({
    path: WorkspacePath,
    contentType: MediaType,
    // Counted in UTF-16 units rather than bytes, which is the cheap check; the route's body limit
    // is what actually bounds how much reaches this service.
    text: z.string().max(MAX_SOURCE_BYTES),
});
export type SourceUpsert = z.infer<typeof SourceUpsert>;

/**
 * A save is what changed, never the whole set.
 *
 * Sources carry their text. Assets carry only a path, because their bytes went straight to the
 * bucket through a presigned PUT and this service reads back what actually landed rather than
 * taking the editor's word for it. `baseRevision` is the revision the edit started from, so a
 * second editor's save is a conflict rather than a silent overwrite.
 */
export const WorkspaceSave = z
    .object({
        baseRevision: z.int().nonnegative(),
        sources: z.array(SourceUpsert).max(MAX_WORKSPACE_FILES).default([]),
        assets: z.array(WorkspacePath).max(MAX_WORKSPACE_FILES).default([]),
        deletes: z.array(WorkspacePath).max(MAX_WORKSPACE_FILES).default([]),
    })
    .refine(
        (save) => {
            const named = [
                ...save.sources.map((file) => file.path),
                ...save.assets,
                ...save.deletes,
            ];
            return new Set(named).size === named.length;
        },
        { error: 'a path may appear once across a save' },
    );
export type WorkspaceSave = z.infer<typeof WorkspaceSave>;

/**
 * The set one save froze: written once under the revision that named it, and never rewritten.
 *
 * This is the version history and the rollback target — every path the game held at that instant
 * and the exact version of the bytes at it. A build pins to one, which is what stops it picking up
 * an edit made after the button was pressed.
 */
export const Manifest = z.object({
    gameId: GameId,
    revision: z.int().positive(),
    files: FileSet,
});
export type Manifest = z.infer<typeof Manifest>;

/**
 * The bytes a manifest is stored as.
 *
 * Spelled out member by member, in path order, rather than stringified from the value it was
 * handed: what a build reads back has to be what the save meant, and a caller's key order would
 * make a game's stored history depend on how one request happened to be serialised.
 */
export function encodeManifest(manifest: Manifest): string {
    return JSON.stringify({
        gameId: manifest.gameId,
        revision: manifest.revision,
        files: manifest.files
            .toSorted((left, right) => (left.path < right.path ? -1 : 1))
            .map((file) => ({
                path: file.path,
                kind: file.kind,
                versionId: file.versionId,
                byteLength: file.byteLength,
                contentType: file.contentType,
            })),
    });
}

/** What the creator last published, which is the manifest revision a build was asked for. */
export const PublishedVersion = z.object({
    revision: z.int().positive(),
    publishedAt: z.iso.datetime(),
});
export type PublishedVersion = z.infer<typeof PublishedVersion>;

/**
 * The newest version anybody can actually play, which is a different fact from the one above.
 *
 * A publish asks for a build; this is the newest build that finished and registered a bundle set.
 * Reading `PublishedVersion` here would send a player at a revision that failed to compile, or at
 * one still compiling — neither of which any box can be asked to run.
 */
export const PlayableVersion = z.object({ revision: z.int().positive(), bundles: BundleSet });
export type PlayableVersion = z.infer<typeof PlayableVersion>;

/** Where an asset's bytes are going, asked for before they are sent. */
export const AssetUploadRequest = z.object({
    path: WorkspacePath,
    contentType: MediaType,
});
export type AssetUploadRequest = z.infer<typeof AssetUploadRequest>;

/**
 * A presigned PUT and how long it is good for.
 *
 * Nothing is recorded when this is handed out: a presign the editor never uses must not leave a
 * row behind. The save that names the path afterwards is what puts the asset in a manifest.
 */
export const AssetUpload = z.object({
    path: WorkspacePath,
    url: z.url(),
    expiresAt: z.iso.datetime(),
    maxBytes: z.int().positive(),
});
export type AssetUpload = z.infer<typeof AssetUpload>;

/**
 * Where one file's bytes sit in the games bucket.
 *
 * Game first, then class: every key a game owns shares one prefix, which is what lets one bucket
 * policy reach a game's build output and its assets while leaving its source unreachable.
 */
export function objectKey(game: GameId, kind: FileKind, path: WorkspacePath): string {
    return `${game}/${kind === 'source' ? 'source' : 'assets'}/${path}`;
}

/** Where the snapshot of one revision sits, which is the only key a build is ever handed. */
export function manifestKey(game: GameId, revision: number): string {
    return `${game}/manifests/${String(revision)}.json`;
}

/** The prefix one build writes under, immutable because the revision naming it is. */
export function buildPrefix(game: GameId, revision: number): string {
    return `${game}/build/${String(revision)}/`;
}
