import type {
    Account,
    Game,
    GameId,
    SourceUpsert,
    Workspace,
    WorkspaceFile,
    WorkspacePath,
    WorkspaceSave,
} from '@grove/api-contract';
import type { ProjectManifest } from '@platform/project';
import type { Api } from '../api/client';
import { PROJECT_PATH, readProject, stamp } from '../project/manifest';
import { scanScripts } from '../project/scripts';
import { bytesOf, draftFromBytes, isText, type DraftFile, type Pending } from './files';
import { DEFAULT_TEMPLATE, seedFrom } from './templates';

/** The title a game gets when the editor made it rather than a creator naming one. */
const FIRST_TITLE = 'Untitled game';

/** What the loading screen is reporting on, in the order it happens. */
export type OpenStep = 'account' | 'game' | 'files';

/** Everything the workbench needs to open: who is editing, what, and what is in it. */
export interface OpenGame {
    account: Account;
    game: Game;
    revision: number;
    /** The set the service last saved, which is what a reload is measured against. */
    saved: WorkspaceFile[];
    files: DraftFile[];
    /** The manifest, which is one of those files — the settings gear's, and a build's. */
    project: ProjectManifest;
    /** The file the workbench opens on; a game whose template said nothing opens on its first. */
    openPath: string | undefined;
    /** Whether the files above are a template nothing has stored yet. */
    seeded: boolean;
}

/**
 * The three steps behind the loading screen: who is signed in, which game, and what is in it.
 *
 * A game with nothing saved is seeded from a template **in memory** and left unsaved. Opening an
 * editor is not a reason to write to somebody's game, so the first save is the creator's.
 */
export async function openGame(api: Api, report: (step: OpenStep) => void): Promise<OpenGame> {
    report('account');
    const account = await api.me();

    report('game');
    const owned = await api.games();
    // The list is newest first, so the most recently made game is the one an editor opens on.
    const game = owned[0] ?? (await api.createGame(FIRST_TITLE));

    report('files');
    const workspace = await api.workspace(game.gameId);
    if (workspace.files.length === 0) {
        const seed = await seedFrom(DEFAULT_TEMPLATE, game.gameId);
        return {
            account,
            game,
            revision: workspace.revision,
            saved: [],
            files: seed.files,
            project: seed.project,
            openPath: DEFAULT_TEMPLATE.openPath,
            seeded: true,
        };
    }

    const held = await contentsOf(api, game.gameId, workspace);
    return {
        account,
        game,
        ...held,
        project: await projectOf(held.files, game.gameId),
        openPath: undefined,
        seeded: false,
    };
}

/**
 * The manifest a stored game holds, or one made for a game saved before it had any.
 *
 * A game with sources and no manifest is given the default template's settings and the classes its
 * own code declares — the alternative is refusing to open a game over a file the creator never
 * typed. It is left for the first save to store, like anything else that changed.
 */
async function projectOf(files: readonly DraftFile[], projectId: string): Promise<ProjectManifest> {
    const held = files.find((file) => file.path === PROJECT_PATH)?.text;
    if (held !== undefined) return readProject(held);

    const sources = files.flatMap((file) =>
        file.text === undefined || file.path === PROJECT_PATH
            ? []
            : [{ path: file.path, text: file.text }],
    );
    return stamp(
        { ...DEFAULT_TEMPLATE.project, projectId },
        scanScripts(sources).modules,
        new Map(sources.map((source) => [source.path, source.text])),
    );
}

/**
 * The saved set again, as drafts.
 *
 * What a conflict reloads through: a second editor won the revision, so what is on this screen is
 * measured against nothing the service holds and has to be replaced by what does.
 */
export async function reloadGame(
    api: Api,
    game: GameId,
): Promise<{
    revision: number;
    saved: WorkspaceFile[];
    files: DraftFile[];
    project: ProjectManifest;
}> {
    const held = await contentsOf(api, game, await api.workspace(game));
    return { ...held, project: await projectOf(held.files, game) };
}

async function contentsOf(
    api: Api,
    game: GameId,
    workspace: Workspace,
): Promise<{ revision: number; saved: WorkspaceFile[]; files: DraftFile[] }> {
    const files = await Promise.all(
        workspace.files.map(async (file) =>
            draftFromBytes(file.path, await api.file(game, file.path), file.contentType),
        ),
    );
    return { revision: workspace.revision, saved: workspace.files, files };
}

/**
 * What one save sends: the text of every source written since the last one, the assets uploaded
 * beside it, and the paths removed.
 *
 * A path nobody touched is not here at all, which is what keeps the typing loop the size of the
 * file being typed in rather than the size of the game.
 */
export function saveOf(
    baseRevision: number,
    drafts: readonly DraftFile[],
    pending: Pending,
): { save: WorkspaceSave; assets: DraftFile[] } {
    const upserted = drafts.filter((draft) => pending.upserted.has(draft.path));
    const sources: SourceUpsert[] = upserted
        .filter((draft) => isText(draft.contentType))
        .map((draft) => ({
            path: draft.path as WorkspacePath,
            contentType: draft.contentType,
            text: draft.text ?? '',
        }));
    const assets = upserted.filter((draft) => !isText(draft.contentType));

    return {
        save: {
            baseRevision,
            sources,
            assets: assets.map((draft) => draft.path as WorkspacePath),
            deletes: [...pending.removed] as WorkspacePath[],
        },
        assets,
    };
}

/**
 * Uploads what changed and then commits it.
 *
 * The assets go first, straight to the bucket through a presigned PUT: the service refuses a save
 * naming an asset that never landed, so an upload that failed has to fail here rather than as a
 * save that half-committed. Their bytes never pass through @grove/api at all.
 */
export async function saveGame(
    api: Api,
    game: GameId,
    baseRevision: number,
    drafts: readonly DraftFile[],
    pending: Pending,
): Promise<Workspace> {
    const { save, assets } = saveOf(baseRevision, drafts, pending);

    for (const draft of assets) {
        // One at a time on purpose: a burst of multi-megabyte bodies is a worse neighbour on a
        // creator's own uplink than an upload that takes a moment longer.
        // oxlint-disable-next-line no-await-in-loop
        const upload = await api.assetUpload(game, draft.path as WorkspacePath, draft.contentType);
        // oxlint-disable-next-line no-await-in-loop
        await api.putAsset(upload, bytesOf(draft), draft.contentType);
    }

    return api.save(game, save);
}
