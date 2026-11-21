import type { Workspace, WorkspaceFile } from '@grove/api-contract';
import type { ProjectManifest } from '@platform/project';
import { PROJECT_PATH, isProjectFile, projectDraft } from '../project/manifest';
import { NOTHING_PENDING, draftFromText, dropped, touched, without } from './files';
import type { DraftFile, Pending } from './files';
import type { Held, OpenGame } from './session';

/** The game as this tab holds it: the drafts, what the service last saved, and what is still owed. */
export interface WorkspaceState {
    files: readonly DraftFile[];
    /** The set the service last saved, which is what a delete is measured against. */
    saved: readonly WorkspaceFile[];
    revision: number;
    /** The manifest, which is also one of the files: this is the same value parsed. */
    project: ProjectManifest;
    pending: Pending;
    /** Owed paths the last save could not carry, which no save nobody asked for tries again. */
    held: Held;
    /** A template nothing has stored, owed in full to the first save the creator brings about. */
    seeded: boolean;
    /** What the last conflict reload kept of this tab's work, or nothing before there was one. */
    rebase: Rebase | undefined;
}

/** A conflict reload: the revision it landed on, and where each path both sides changed was kept. */
export interface Rebase {
    revision: number;
    /** A path somebody else also changed, to the copy beside it that holds this tab's text. */
    copies: ReadonlyMap<string, string>;
}

export type WorkspaceAction =
    | { type: 'edit'; path: string; text: string }
    | { type: 'project'; project: ProjectManifest }
    | { type: 'add'; path: string }
    | { type: 'import'; draft: DraftFile }
    | { type: 'remove'; path: string }
    | {
          type: 'saved';
          /** `undefined` for a save that could send nothing, which moves no revision. */
          workspace: Workspace | undefined;
          /** What the save carried, captured before it left. */
          sent: Pending;
          held: Held;
          drafts: ReadonlyMap<string, DraftFile>;
      }
    | {
          type: 'reloaded';
          revision: number;
          saved: readonly WorkspaceFile[];
          files: readonly DraftFile[];
          project: ProjectManifest;
      };

const NOTHING_HELD: Held = new Map();

export function initialWorkspace(opened: OpenGame): WorkspaceState {
    return {
        files: opened.files,
        saved: opened.saved,
        revision: opened.revision,
        project: opened.project,
        // Nothing is owed on arrival, a template included: opening is not a reason to write.
        pending: NOTHING_PENDING,
        held: NOTHING_HELD,
        seeded: opened.seeded,
        rebase: undefined,
    };
}

/** Everything a save the creator asked for would carry: a seeded template is owed whole. */
export function owedOf(state: WorkspaceState): Pending {
    return state.seeded
        ? { upserted: new Set(state.files.map((file) => file.path)), removed: new Set() }
        : state.pending;
}

/** What a save nobody asked for carries: the same, less what the last one could not. */
export function autosaveOf(state: WorkspaceState): Pending {
    return without(state.pending, state.held);
}

/** The state an edit lands on: a template nothing stored becomes owed whole at the first one. */
function claimed(state: WorkspaceState): WorkspaceState {
    if (!state.seeded) return state;
    return { ...state, seeded: false, pending: owedOf(state) };
}

function release(held: Held, path: string): Held {
    if (!held.has(path)) return held;
    const next = new Map(held);
    next.delete(path);
    return next;
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
    switch (action.type) {
        case 'edit': {
            // An asset is carried, not edited: a keystroke in the tab describing one is not a change.
            const file = state.files.find((each) => each.path === action.path);
            if (file?.text === undefined) return state;
            const base = claimed(state);
            return {
                ...base,
                files: base.files.map((each) =>
                    each.path === action.path ? { ...each, text: action.text } : each,
                ),
                pending: touched(base.pending, action.path),
                held: release(base.held, action.path),
            };
        }
        case 'project': {
            const base = claimed(state);
            const draft = projectDraft(action.project);
            return {
                ...base,
                project: action.project,
                files: base.files.some((file) => isProjectFile(file.path))
                    ? base.files.map((file) => (isProjectFile(file.path) ? draft : file))
                    : [...base.files, draft],
                pending: touched(base.pending, PROJECT_PATH),
            };
        }
        case 'add': {
            if (action.path === '' || state.files.some((file) => file.path === action.path)) {
                return state;
            }
            const base = claimed(state);
            return {
                ...base,
                files: [...base.files, draftFromText(action.path, '')],
                pending: touched(base.pending, action.path),
            };
        }
        case 'import': {
            const base = claimed(state);
            return {
                ...base,
                files: [
                    ...base.files.filter((file) => file.path !== action.draft.path),
                    action.draft,
                ],
                pending: touched(base.pending, action.draft.path),
                held: release(base.held, action.draft.path),
            };
        }
        case 'remove': {
            const base = claimed(state);
            return {
                ...base,
                files: base.files.filter((file) => file.path !== action.path),
                pending: dropped(
                    base.pending,
                    action.path,
                    base.saved.some((file) => file.path === action.path),
                ),
                held: release(base.held, action.path),
            };
        }
        case 'saved': {
            // Every save of this tab's is answered in order, so an older answer is one superseded.
            if (action.workspace !== undefined && action.workspace.revision < state.revision) {
                return state;
            }
            // A seed some save carried is owed whole until that save's answer says otherwise.
            const base =
                action.workspace === undefined && action.held.size === 0 ? state : claimed(state);
            // A path typed in again mid-flight is still owed: a draft is replaced on every edit,
            // so a different object than the one sent is text the service has not seen.
            const edited = (path: string): boolean =>
                base.files.find((file) => file.path === path) !== action.drafts.get(path);
            const upserted = new Set(
                [...base.pending.upserted].filter(
                    (path) => !action.sent.upserted.has(path) || edited(path),
                ),
            );
            const held = new Map(
                [...base.held].filter(([path]) => upserted.has(path) && !action.held.has(path)),
            );
            for (const [path, why] of action.held) {
                if (upserted.has(path) && !edited(path)) held.set(path, why);
            }
            return {
                ...base,
                revision: action.workspace?.revision ?? base.revision,
                saved: action.workspace?.files ?? base.saved,
                pending: {
                    upserted,
                    removed: new Set(
                        [...base.pending.removed].filter((path) => !action.sent.removed.has(path)),
                    ),
                },
                held,
            };
        }
        case 'reloaded':
            return rebased(state, action);
    }
}

/** The sibling a path's losing text is kept at: `main.ts` beside `main.conflict.ts`, or a later one. */
export function conflictPath(path: string, taken: ReadonlySet<string>): string {
    const dot = path.lastIndexOf('.');
    const [stem, extension] =
        dot > path.lastIndexOf('/') + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ''];
    for (let attempt = 1; ; attempt += 1) {
        const copy = `${stem}.conflict${attempt === 1 ? '' : `-${String(attempt)}`}${extension}`;
        if (!taken.has(copy)) return copy;
    }
}

/** The service's set with this tab's work put back on top, and copied aside where both changed a path. */
function rebased(
    state: WorkspaceState,
    remote: Extract<WorkspaceAction, { type: 'reloaded' }>,
): WorkspaceState {
    // A template nothing stored is not anybody's work yet, so the service's set simply wins.
    const owed = state.seeded ? NOTHING_PENDING : state.pending;
    const based = new Map(state.saved.map((file) => [file.path, file.versionId]));
    const theirs = new Map(remote.saved.map((file) => [file.path, file.versionId]));
    // A draft whose base is still the stored version is safe to re-apply; any other is a conflict.
    const moved = (path: string): boolean =>
        theirs.has(path) && theirs.get(path) !== based.get(path);

    const files = new Map(remote.files.map((file) => [file.path, file]));
    const upserted = new Set<string>();
    const removed = new Set<string>();
    const copies = new Map<string, string>();
    let project = remote.project;

    for (const path of owed.upserted) {
        const mine = state.files.find((file) => file.path === path);
        if (mine === undefined) continue;
        const stored = files.get(path);
        if (!moved(path)) {
            files.set(path, mine);
            upserted.add(path);
            if (isProjectFile(path)) project = state.project;
            continue;
        }
        // Both arriving at the same text is no conflict at all.
        if (mine.text !== undefined && stored?.text === mine.text) continue;
        const copy = conflictPath(
            path,
            new Set([...files.keys(), ...state.files.map((file) => file.path)]),
        );
        files.set(copy, { ...mine, path: copy });
        upserted.add(copy);
        copies.set(path, copy);
    }
    for (const path of owed.removed) {
        // Gone on both sides needs no delete, and an edit they made outlives a delete this tab did.
        if (!theirs.has(path) || moved(path)) continue;
        files.delete(path);
        removed.add(path);
    }

    return {
        files: [...files.values()],
        saved: remote.saved,
        revision: remote.revision,
        project,
        pending:
            upserted.size === 0 && removed.size === 0 ? NOTHING_PENDING : { upserted, removed },
        held: new Map([...state.held].filter(([path]) => upserted.has(path))),
        seeded: false,
        rebase: { revision: remote.revision, copies },
    };
}
