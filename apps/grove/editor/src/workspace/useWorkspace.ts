import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { messageOf } from '@grove/ui';
import type { ProjectManifest } from '@platform/project';
import type { Api } from '../api/client';
import { ApiError, isLapsedSession } from '../api/client';
import type { SaveState } from '../shell/TopBar';
import { useAutosave, useCrashFlush } from './autosave';
import { UNKNOWN_TYPE, draftFromBytes, isPending, mediaTypeOf } from './files';
import type { DraftFile } from './files';
import { exitSaveOf, reloadGame, saveGame } from './session';
import type { OpenGame } from './session';
import { initialWorkspace, workspaceReducer } from './state';
import type { WorkspaceState } from './state';

/** What the top bar says for a save or a reload that did not go through. */
const SAVE_FAILED = 'something went wrong';

export interface WorkspaceOptions {
    api: Api;
    opened: OpenGame;
    /**
     * Runs once when the service stops recognising this session while there is work on screen.
     *
     * Whatever this does has to leave the screen standing: there is unsaved work here.
     */
    onSessionLapsed: () => void;
    /** Hands over the files a reload replaced everything with, for whatever mirrors them. */
    onReloaded: (files: readonly DraftFile[]) => void;
}

export interface WorkspaceHandle extends WorkspaceState {
    /** Whether anything is owed to the service. */
    dirty: boolean;
    /** Where the last save got to. */
    saveState: SaveState;
    save: () => void;
    edit: (path: string, text: string) => void;
    writeProject: (project: ProjectManifest) => void;
    /** Answers whether there was a file to add: a name already taken adds nothing. */
    addFile: (path: string) => boolean;
    /** Resolves to whether the picked file is text, which is a file worth opening a tab on. */
    importFile: (picked: File) => Promise<boolean>;
    removeFile: (path: string) => void;
}

/**
 * The game this tab is editing, and the saving of it.
 *
 * One save at a time: a second sent while the first is in flight carries the revision the first
 * is about to replace, and loses to it as a conflict that reloads away what was typed. A save
 * asked for meanwhile is owed, and goes once the first settles, with whatever is held by then.
 */
export function useWorkspace({
    api,
    opened,
    onSessionLapsed,
    onReloaded,
}: WorkspaceOptions): WorkspaceHandle {
    const [state, dispatch] = useReducer(workspaceReducer, opened, initialWorkspace);
    const [saveState, setSaveState] = useState<SaveState>({ at: 'idle' });
    const dirty = isPending(state.pending);
    const gameId = opened.game.gameId;

    const saving = useRef(false);
    const owed = useRef(false);
    const [retries, setRetries] = useState(0);
    // Autosave keeps retrying while anything is unsaved and every retry refuses the same way;
    // without this a lapsed session is an alert every few seconds.
    const told = useRef(false);

    function lapsed(failure: unknown): boolean {
        if (!isLapsedSession(failure)) return false;
        if (!told.current) {
            told.current = true;
            onSessionLapsed();
        }
        setSaveState({
            at: 'failed',
            message: 'your Grove session ended; sign in again, then save',
        });
        return true;
    }

    /**
     * Throws away what is on this screen and takes what the service holds.
     *
     * A second editor claimed this revision, so there is no set here to merge into: warning and
     * reloading is the honest answer, where saving over it would be one creator silently
     * overwriting the other.
     */
    async function reload(): Promise<void> {
        const current = await reloadGame(api, gameId);
        dispatch({ type: 'reloaded', ...current });
        onReloaded(current.files);
        setSaveState({
            at: 'failed',
            message: `somebody else saved this game; reloaded at revision ${String(current.revision)}`,
        });
    }

    async function save(): Promise<void> {
        if (!dirty) return;
        if (saving.current) {
            owed.current = true;
            return;
        }
        saving.current = true;
        setSaveState({ at: 'saving' });
        // Captured before the request: a keystroke landing while it is in flight belongs to the
        // next save, and clearing the whole set afterwards would swallow it.
        const sent = state.pending;
        const drafts = new Map(state.files.map((file) => [file.path, file]));
        try {
            const workspace = await saveGame(api, gameId, state.revision, state.files, sent);
            dispatch({ type: 'saved', workspace, sent, drafts });
            setSaveState({ at: 'saved' });
            // A save that landed is a session that answered, so the next lapse is a fresh one.
            told.current = false;
        } catch (failure) {
            if (lapsed(failure)) return;
            if (failure instanceof ApiError && failure.status === 409) {
                // The reload is a read against the same session, and can refuse the same way.
                await reload().catch((second: unknown) => {
                    if (!lapsed(second)) {
                        setSaveState({ at: 'failed', message: messageOf(second, SAVE_FAILED) });
                    }
                });
                return;
            }
            setSaveState({ at: 'failed', message: messageOf(failure, SAVE_FAILED) });
        } finally {
            saving.current = false;
            if (owed.current) {
                owed.current = false;
                setRetries((count) => count + 1);
            }
        }
    }

    // The owed save runs from the render after the first settled, so it sends what is held now.
    useEffect(() => {
        if (retries > 0) void save();
    }, [retries]);

    /** The one save a tab gets on its way out: fired and not waited on, because nothing waits. */
    function flush(): void {
        void api.saveOnExit(gameId, exitSaveOf(state.revision, state.files, state.pending));
    }

    useAutosave({ pending: state.pending, save: () => void save(), flush });
    useCrashFlush(dirty ? flush : undefined);

    // Stable, because the code editor holds the edit listener across renders.
    const edit = useCallback((path: string, text: string) => {
        dispatch({ type: 'edit', path, text });
        setSaveState({ at: 'idle' });
    }, []);
    const writeProject = useCallback((project: ProjectManifest) => {
        dispatch({ type: 'project', project });
        setSaveState({ at: 'idle' });
    }, []);

    return {
        ...state,
        dirty,
        saveState,
        save: () => void save(),
        edit,
        writeProject,
        addFile: (path) => {
            if (path === '' || state.files.some((file) => file.path === path)) return false;
            dispatch({ type: 'add', path });
            return true;
        },
        importFile: async (picked) => {
            const bytes = new Uint8Array(await picked.arrayBuffer());
            // The extension first: a browser reports what its OS registry says, and a .ts file is
            // `video/mp2t` there.
            const known = mediaTypeOf(picked.name);
            const type = known !== UNKNOWN_TYPE || picked.type === '' ? known : picked.type;
            const draft = draftFromBytes(picked.name, bytes, type);
            dispatch({ type: 'import', draft });
            return draft.text !== undefined;
        },
        removeFile: (path) => dispatch({ type: 'remove', path }),
    };
}
