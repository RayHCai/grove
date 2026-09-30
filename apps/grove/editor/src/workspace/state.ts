import type { Workspace, WorkspaceFile } from '@grove/api-contract';
import type { ProjectManifest } from '@platform/project';
import { PROJECT_PATH, isProjectFile, projectDraft } from '../project/manifest';
import { NOTHING_PENDING, draftFromText, dropped, touched } from './files';
import type { DraftFile, Pending } from './files';
import type { OpenGame } from './session';

/** The game as this tab holds it: the drafts, what the service last saved, and what is still owed. */
export interface WorkspaceState {
    files: readonly DraftFile[];
    /** The set the service last saved, which is what a delete is measured against. */
    saved: readonly WorkspaceFile[];
    revision: number;
    /** The manifest, which is also one of the files: this is the same value parsed. */
    project: ProjectManifest;
    pending: Pending;
}

export type WorkspaceAction =
    | { type: 'edit'; path: string; text: string }
    | { type: 'project'; project: ProjectManifest }
    | { type: 'add'; path: string }
    | { type: 'import'; draft: DraftFile }
    | { type: 'remove'; path: string }
    | {
          type: 'saved';
          workspace: Workspace;
          /** What the save carried, captured before it left. */
          sent: Pending;
          drafts: ReadonlyMap<string, DraftFile>;
      }
    | {
          type: 'reloaded';
          revision: number;
          saved: readonly WorkspaceFile[];
          files: readonly DraftFile[];
          project: ProjectManifest;
      };

export function initialWorkspace(opened: OpenGame): WorkspaceState {
    return {
        files: opened.files,
        saved: opened.saved,
        revision: opened.revision,
        project: opened.project,
        // A template seeded in memory is owed to the service in full: nothing of it has been saved.
        pending: opened.seeded
            ? { upserted: new Set(opened.files.map((file) => file.path)), removed: new Set() }
            : NOTHING_PENDING,
    };
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
    switch (action.type) {
        case 'edit':
            return {
                ...state,
                files: state.files.map((file) =>
                    // An asset has no text to replace; the tab opened on one shows a description.
                    file.path === action.path && file.text !== undefined
                        ? { ...file, text: action.text }
                        : file,
                ),
                pending: touched(state.pending, action.path),
            };
        case 'project': {
            const draft = projectDraft(action.project);
            return {
                ...state,
                project: action.project,
                files: state.files.some((file) => isProjectFile(file.path))
                    ? state.files.map((file) => (isProjectFile(file.path) ? draft : file))
                    : [...state.files, draft],
                pending: touched(state.pending, PROJECT_PATH),
            };
        }
        case 'add':
            if (action.path === '' || state.files.some((file) => file.path === action.path)) {
                return state;
            }
            return {
                ...state,
                files: [...state.files, draftFromText(action.path, '')],
                pending: touched(state.pending, action.path),
            };
        case 'import':
            return {
                ...state,
                files: [
                    ...state.files.filter((file) => file.path !== action.draft.path),
                    action.draft,
                ],
                pending: touched(state.pending, action.draft.path),
            };
        case 'remove':
            return {
                ...state,
                files: state.files.filter((file) => file.path !== action.path),
                pending: dropped(
                    state.pending,
                    action.path,
                    state.saved.some((file) => file.path === action.path),
                ),
            };
        case 'saved': {
            // A path typed in again mid-flight is still owed: a draft is replaced on every edit,
            // so a different object than the one sent is text the service has not seen.
            const edited = (path: string): boolean =>
                state.files.find((file) => file.path === path) !== action.drafts.get(path);
            return {
                ...state,
                revision: action.workspace.revision,
                saved: action.workspace.files,
                pending: {
                    upserted: new Set(
                        [...state.pending.upserted].filter(
                            (path) => !action.sent.upserted.has(path) || edited(path),
                        ),
                    ),
                    removed: new Set(
                        [...state.pending.removed].filter((path) => !action.sent.removed.has(path)),
                    ),
                },
            };
        }
        case 'reloaded':
            return {
                files: action.files,
                saved: action.saved,
                revision: action.revision,
                project: action.project,
                pending: NOTHING_PENDING,
            };
    }
}
