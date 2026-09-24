// The fixtures every suite below drives the editor with: a service that answers out of memory, and
// the project the template opens as.

import type {
    Account,
    AssetUpload,
    Game,
    GameId,
    PlayerId,
    SignedIn,
    Task,
    VersionId,
    Workspace,
    WorkspaceFile,
    WorkspacePath,
    WorkspaceSave,
} from '@grove/api-contract';
import { PROJECT_FORMAT_VERSION } from '@platform/project';
import type { ProjectManifest } from '@platform/project';
import type { Api } from '../src/api/client';
import { ApiError } from '../src/api/client';
import { asProjectFile, treeOf } from '../src/project/files';
import type { ProjectFile, ProjectNode } from '../src/project/files';
import { projectDraft } from '../src/project/manifest';
import { scanScripts } from '../src/project/scripts';
import { bytesOf, draftFromText, isText } from '../src/workspace/files';
import type { DraftFile } from '../src/workspace/files';
import type { OpenGame } from '../src/workspace/session';
import { DEFAULT_TEMPLATE } from '../src/workspace/templates';

export const PLAYER_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479' as PlayerId;
export const GAME_ID = '9f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f' as GameId;
export const TASK_ID = '8c2e4a60-5d17-4b93-8f0a-1e6d2c4b7a35' as Task['taskId'];

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
    createdAt: '2026-09-01T09:00:00.000Z',
};

/** The file the default template opens on, which most of these suites type into. */
export const TEMPLATE_PATH = DEFAULT_TEMPLATE.openPath;

/**
 * The default template's manifest, stamped by hand.
 *
 * A digest is the editor's to compute and is asynchronous; a fixture pins one so a suite can build
 * an opened game without awaiting anything.
 */
export const PROJECT: ProjectManifest = {
    ...DEFAULT_TEMPLATE.project,
    formatVersion: PROJECT_FORMAT_VERSION,
    projectId: GAME_ID,
    contentHash: 'a-fixture-hash',
    scriptModules: scanScripts(
        DEFAULT_TEMPLATE.files().flatMap((file) =>
            file.text === undefined ? [] : [{ path: file.path, text: file.text }],
        ),
    ).modules,
};

/** What a game seeded from the default template holds: its sources, and the manifest beside them. */
export function templateDrafts(): DraftFile[] {
    return [...DEFAULT_TEMPLATE.files(), projectDraft(PROJECT)];
}

/** A game that is plain TypeScript: no script class, and so nothing for a world to instantiate. */
export const PLAIN_PROJECT: ProjectManifest = {
    ...PROJECT,
    templates: [],
    gameScripts: [],
    scriptModules: [],
};

/**
 * A few files across two folders, which is what the tree and the tab strip are driven with.
 *
 * Its own set rather than the template's: what a template holds is a product decision that moves,
 * and a suite about folder order should not be rewritten every time it does.
 */
export function sampleFiles(): DraftFile[] {
    return [
        draftFromText('src/main.ts', 'export const start = 1;\n'),
        draftFromText('src/sprout.ts', 'export const grow = 2;\n'),
        draftFromText('src/garden.ts', 'export const plot = 3;\n'),
        draftFromText('hud/hud.ts', 'export const draw = 4;\n'),
        draftFromText('game.config.ts', 'export const config = {};\n'),
    ];
}

export function project(files: readonly DraftFile[] = sampleFiles()): ProjectFile[] {
    return files.map(asProjectFile);
}

export function projectTree(files?: readonly DraftFile[]): ProjectNode[] {
    return treeOf(project(files));
}

export function fileAt(path: string): ProjectFile {
    const found = project().find((file) => file.path === path);
    if (found === undefined) throw new Error(`${path} is not in the sample`);
    return found;
}

/** A game already open, as the boot sequence would have handed it over. */
export function opened(over: Partial<OpenGame> = {}): OpenGame {
    return {
        account: ACCOUNT,
        game: GAME,
        revision: 0,
        saved: [],
        files: templateDrafts(),
        project: PROJECT,
        openPath: DEFAULT_TEMPLATE.openPath,
        seeded: true,
        ...over,
    };
}

export interface FakeApi extends Api {
    /** Every key the bucket holds, by the path the editor put it at. */
    readonly bucket: Map<string, { bytes: Uint8Array; type: string }>;
    /** Every presign handed out, whether or not the bytes ever followed. */
    readonly signed: WorkspacePath[];
    readonly saves: WorkspaceSave[];
    readonly publishes: GameId[];
    workspaceState: Workspace;
    owned: Game[];
    signedIn: boolean;
}

/**
 * The service, out of memory.
 *
 * It refuses the way the real one does — a stale save is a conflict, an asset nobody uploaded is a
 * 400, and a call with no session is a 401 — because those are the branches the editor has to
 * answer for.
 */
export function fakeApi(over: Partial<FakeApi> = {}): FakeApi {
    let minted = 0;
    const version = (): VersionId => {
        minted += 1;
        return `v${String(minted)}` as VersionId;
    };

    const api: FakeApi = {
        bucket: new Map(),
        signed: [],
        saves: [],
        publishes: [],
        signedIn: true,
        owned: [GAME],
        workspaceState: {
            gameId: GAME_ID,
            revision: 0,
            files: [],
            updatedAt: '2026-09-16T09:00:00.000Z',
        },

        session: async () => (api.signedIn ? signedIn() : undefined),
        signOut: async () => {
            api.signedIn = false;
        },

        me: async () => guard(api, ACCOUNT),
        games: async () => guard(api, api.owned),
        createGame: async (title) => {
            const made = { ...GAME, title };
            api.owned = [made];
            return made;
        },

        workspace: async () => guard(api, api.workspaceState),
        save: async (_game, save) => {
            if (save.baseRevision !== api.workspaceState.revision) {
                throw new ApiError(409, 'conflict', 'the workspace is at a later revision');
            }
            const absent = save.assets.filter((path) => !api.bucket.has(path));
            if (absent.length > 0) {
                throw new ApiError(400, 'invalid_request', `never uploaded: ${absent.join(', ')}`);
            }

            for (const source of save.sources) {
                api.bucket.set(source.path, {
                    bytes: new TextEncoder().encode(source.text),
                    type: source.contentType,
                });
            }
            for (const path of save.deletes) api.bucket.delete(path);

            const kept = api.workspaceState.files.filter(
                (file) =>
                    !save.deletes.includes(file.path) &&
                    !save.sources.some((source) => source.path === file.path) &&
                    !save.assets.includes(file.path),
            );
            const written: WorkspaceFile[] = [
                ...save.sources.map((source) => ({
                    path: source.path,
                    kind: 'source' as const,
                    versionId: version(),
                    byteLength: new TextEncoder().encode(source.text).byteLength,
                    contentType: source.contentType,
                })),
                ...save.assets.map((path) => ({
                    path,
                    kind: 'asset' as const,
                    versionId: version(),
                    byteLength: api.bucket.get(path)?.bytes.byteLength ?? 0,
                    contentType: api.bucket.get(path)?.type ?? 'application/octet-stream',
                })),
            ];

            api.saves.push(save);
            api.workspaceState = {
                ...api.workspaceState,
                revision: save.baseRevision + 1,
                files: [...kept, ...written].toSorted((left, right) =>
                    left.path < right.path ? -1 : 1,
                ),
            };
            return api.workspaceState;
        },
        saveOnExit: async (game, save) => {
            // The real one never reports anything either: the page is going.
            await api.save(game, save).catch(() => undefined);
        },
        file: async (_game, path) => {
            const held = api.bucket.get(path);
            if (held === undefined) throw new ApiError(404, 'not_found', 'no such file');
            return held.bytes;
        },

        assetUpload: async (_game, path) => {
            api.signed.push(path);
            return {
                path,
                url: `https://games.example/${GAME_ID}/assets/${path}`,
                expiresAt: '2026-09-16T10:15:00.000Z',
                maxBytes: 32 * 1024 * 1024,
            };
        },
        putAsset: async (upload, bytes, contentType) => {
            api.bucket.set(upload.path, { bytes, type: contentType });
        },

        publish: async (game) => {
            api.publishes.push(game);
            return queued(api.workspaceState.revision);
        },
        task: async (_game, taskId) => ({
            ...queued(api.workspaceState.revision),
            taskId,
        }),
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

function queued(manifestRevision: number): Task {
    return {
        taskId: TASK_ID,
        gameId: GAME_ID,
        kind: 'BUILD',
        status: 'NOT_STARTED',
        manifestRevision,
        attempts: 0,
        createdAt: '2026-09-16T10:00:00.000Z',
        updatedAt: '2026-09-16T10:00:00.000Z',
    };
}

/** A workspace already holding these files, with their bytes in the bucket beside them. */
export async function stored(
    api: FakeApi,
    files: readonly DraftFile[],
    revision = 1,
): Promise<void> {
    let minted = 0;
    const saved: WorkspaceFile[] = [];
    for (const draft of files) {
        minted += 1;
        api.bucket.set(draft.path, { bytes: bytesOf(draft), type: draft.contentType });
        saved.push({
            path: draft.path as WorkspacePath,
            kind: isText(draft.contentType) ? 'source' : 'asset',
            versionId: `held-${String(minted)}` as VersionId,
            byteLength: bytesOf(draft).byteLength,
            contentType: draft.contentType,
        });
    }
    api.workspaceState = {
        ...api.workspaceState,
        revision,
        files: saved.toSorted((left, right) => (left.path < right.path ? -1 : 1)),
    };
}

/** An `AssetUpload` for a path, which a suite driving `putAsset` directly still needs one of. */
export function uploadTo(path: string): AssetUpload {
    return {
        path: path as WorkspacePath,
        url: `https://games.example/${GAME_ID}/assets/${path}`,
        expiresAt: '2026-09-16T10:15:00.000Z',
        maxBytes: 32 * 1024 * 1024,
    };
}
