import { MAX_SOURCE_BYTES } from '@grove/api-contract';
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
import { messageOf } from '@grove/ui';
import type { ProjectManifest } from '@platform/project';
import type { Api } from '../api/client';
import { isLapsedSession } from '../api/client';
import { PROJECT_PATH, readProject, stamp } from '../project/manifest';
import { scanScripts } from '../project/scripts';
import { bytesOf, draftFromBytes, isPending, isText, storedAsset } from './files';
import type { DraftFile, Pending } from './files';
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
    /** The manifest, which is one of those files: the settings gear's, and a build's. */
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
 * own code declares; the alternative is refusing to open a game over a file the creator never
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
            // An asset is carried rather than edited, so its bytes stay in the bucket: the saved
            // set already says how big it is, which is all a tab open on it shows.
            isText(file.contentType)
                ? draftFromBytes(file.path, await api.file(game, file.path), file.contentType)
                : storedAsset(file),
        ),
    );
    return { revision: workspace.revision, saved: workspace.files, files };
}

/** A path a save could not carry, and the sentence that says why. */
export type Held = ReadonlyMap<string, string>;

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
): { save: WorkspaceSave; assets: DraftFile[]; held: Map<string, string> } {
    const upserted = drafts.filter((draft) => pending.upserted.has(draft.path));
    const held = new Map<string, string>();
    const sources: SourceUpsert[] = [];
    for (const draft of upserted) {
        if (!isText(draft.contentType)) continue;
        const text = draft.text ?? '';
        // The service refuses a whole save over one file this long, so it waits on its own.
        if (text.length > MAX_SOURCE_BYTES) {
            held.set(draft.path, `${draft.path} is too long to save until it is split up`);
            continue;
        }
        sources.push({ path: draft.path, contentType: draft.contentType, text });
    }
    const assets = upserted.filter((draft) => !isText(draft.contentType));

    return {
        save: {
            baseRevision,
            sources,
            assets: assets.map((draft) => draft.path),
            deletes: [...pending.removed],
        },
        assets,
        held,
    };
}

/**
 * The save a closing tab sends: its text and its deletes, and none of its assets.
 *
 * There is no time left to upload one, and the service refuses a whole save that names an asset
 * which never landed, so naming them here would lose the text edits along with them.
 */
export function exitSaveOf(
    baseRevision: number,
    drafts: readonly DraftFile[],
    pending: Pending,
): { save: WorkspaceSave; sent: Pending } {
    const { save } = saveOf(baseRevision, drafts, pending);
    return {
        save: { ...save, assets: [] },
        sent: {
            upserted: new Set(save.sources.map((source) => source.path)),
            removed: new Set(save.deletes),
        },
    };
}

/** Uploads that landed and have not been committed yet, so a retried save does not send them twice. */
export type Landed = Map<string, { draft: DraftFile; until: number }>;

/** One save as it went: what the service holds now, what it was sent, and what it could not be. */
export interface SaveOutcome {
    /** `undefined` when nothing the save owed could be sent, so the revision did not move. */
    workspace: Workspace | undefined;
    sent: Pending;
    held: Map<string, string>;
}

/**
 * Uploads what changed and then commits what made it.
 *
 * The assets go first, straight to the bucket through a presigned PUT: the service refuses a save
 * naming an asset that never landed, so one that failed is held back here, said, and kept owed,
 * while the text beside it commits anyway. Their bytes never pass through @grove/api at all.
 */
export async function saveGame(
    api: Api,
    game: GameId,
    baseRevision: number,
    drafts: readonly DraftFile[],
    pending: Pending,
    landed: Landed = new Map(),
): Promise<SaveOutcome> {
    const { save, assets, held } = saveOf(baseRevision, drafts, pending);

    const uploaded: WorkspacePath[] = [];
    for (const draft of assets) {
        try {
            // One at a time: a burst of multi-megabyte bodies is a worse neighbour on an uplink.
            // oxlint-disable-next-line no-await-in-loop
            await upload(api, game, draft, landed);
            uploaded.push(draft.path as WorkspacePath);
        } catch (failure) {
            // Nothing else in this save would be taken either.
            if (isLapsedSession(failure)) throw failure;
            held.set(draft.path, messageOf(failure, `${draft.path} could not be uploaded`));
        }
    }

    const commit: WorkspaceSave = { ...save, assets: uploaded };
    const sent: Pending = {
        upserted: new Set([...commit.sources.map((source) => source.path), ...uploaded]),
        removed: new Set(commit.deletes),
    };
    if (!isPending(sent)) return { workspace: undefined, sent, held };

    const workspace = await api.save(game, commit);
    for (const path of uploaded) landed.delete(path);
    return { workspace, sent, held };
}

async function upload(api: Api, game: GameId, draft: DraftFile, landed: Landed): Promise<void> {
    const before = landed.get(draft.path);
    // The quarantined copy outlives its ticket by far, so within the ticket it is certainly there.
    if (before?.draft === draft && Date.now() < before.until) return;
    if (draft.bytes === undefined) throw new Error(`${draft.path} has no bytes in this tab`);

    const ticket = await api.assetUpload(game, draft.path as WorkspacePath, {
        contentType: draft.contentType,
        byteLength: draft.bytes.byteLength,
    });
    await api.putAsset(ticket, bytesOf(draft));
    landed.set(draft.path, { draft, until: Date.parse(ticket.expiresAt) });
}
