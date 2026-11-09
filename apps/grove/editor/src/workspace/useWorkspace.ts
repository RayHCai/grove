import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { messageOf } from '@grove/ui';
import type { Workspace } from '@grove/api-contract';
import type { ProjectManifest } from '@platform/project';
import type { Api } from '../api/client';
import { ApiError, isLapsedSession } from '../api/client';
import type { SaveState } from '../shell/TopBar';
import { useAutosave, useCrashFlush } from './autosave';
import { draftFromBytes, importTypeOf, isPending, without } from './files';
import type { DraftFile, Pending } from './files';
import { exitSaveOf, reloadGame, saveGame } from './session';
import type { Held, Landed, OpenGame } from './session';
import { autosaveOf, initialWorkspace, owedOf, workspaceReducer } from './state';
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
    /** A save the creator asked for, which also tries again what the last one held back. */
    save: () => void;
    edit: (path: string, text: string) => void;
    writeProject: (project: ProjectManifest) => void;
    /** Answers whether there was a file to add: a name already taken adds nothing. */
    addFile: (path: string) => boolean;
    /** Resolves to whether the picked file is text, which is a file worth opening a tab on. */
    importFile: (picked: File) => Promise<boolean>;
    removeFile: (path: string) => void;
}

/** A save asked for while another was out, and whether the creator was the one who asked. */
type Owed = 'none' | 'auto' | 'asked';

function heldMessage(held: Held): string {
    const [first] = held.values();
    const others = held.size - 1;
    const rest = others === 0 ? '' : ` (and ${String(others)} more)`;
    return `${first ?? SAVE_FAILED}${rest}; everything else saved`;
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
    const dirty = isPending(state.pending) || state.seeded;
    const gameId = opened.game.gameId;

    const saving = useRef(false);
    const owed = useRef<Owed>('none');
    const [retry, setRetry] = useState<{ count: number; asked: boolean }>({
        count: 0,
        asked: false,
    });
    // Autosave keeps retrying while anything is unsaved and every retry refuses the same way;
    // without this a lapsed session is an alert every few seconds.
    const told = useRef(false);
    // The newest revision any save of this tab's landed as, which a stale base is judged against.
    const adopted = useRef(opened.revision);
    // The exit saves still out, since a conflict may be one of them landing first.
    const exits = useRef(new Set<Promise<void>>());
    const landed = useRef<Landed>(new Map());

    function lapsed(failure: unknown): boolean {
        if (!isLapsedSession(failure)) return false;
        if (!told.current) {
            told.current = true;
            onSessionLapsed();
        }
        setSaveState({
            at: 'failed',
            message: 'your Grove session ended; this saves once you sign in again',
        });
        return true;
    }

    function owe(asked: boolean): void {
        owed.current = asked || owed.current === 'asked' ? 'asked' : 'auto';
    }

    function adopt(
        workspace: Workspace | undefined,
        sent: Pending,
        held: Held,
        drafts: ReadonlyMap<string, DraftFile>,
    ): void {
        adopted.current = Math.max(adopted.current, workspace?.revision ?? adopted.current);
        dispatch({ type: 'saved', workspace, sent, held, drafts });
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
        adopted.current = current.revision;
        dispatch({ type: 'reloaded', ...current });
        onReloaded(current.files);
        setSaveState({
            at: 'failed',
            message: `somebody else saved this game; reloaded at revision ${String(current.revision)}`,
        });
    }

    async function save(asked: boolean): Promise<void> {
        // A creator's save carries what the last one held back; one nobody asked for does not.
        const sending = asked ? owedOf(state) : autosaveOf(state);
        if (!isPending(sending)) return;
        if (saving.current) {
            owe(asked);
            return;
        }
        saving.current = true;
        setSaveState({ at: 'saving' });
        // Captured before the request: a keystroke landing while it is in flight belongs to the
        // next save, and clearing the whole set afterwards would swallow it.
        const base = state.revision;
        const drafts = new Map(state.files.map((file) => [file.path, file]));
        try {
            const outcome = await saveGame(api, gameId, base, state.files, sending, landed.current);
            adopt(outcome.workspace, outcome.sent, outcome.held, drafts);
            setSaveState(
                outcome.held.size === 0
                    ? { at: 'saved' }
                    : { at: 'failed', message: heldMessage(outcome.held) },
            );
            // A save that landed is a session that answered, so the next lapse is a fresh one.
            told.current = false;
        } catch (failure) {
            if (lapsed(failure)) return;
            if (failure instanceof ApiError && failure.status === 409) {
                // This tab's own exit save may be what moved the revision, which is no conflict.
                await Promise.allSettled(exits.current);
                if (adopted.current !== base) {
                    // It carried everything this one did but the assets, which the save owed now sends.
                    setSaveState({ at: 'saved' });
                    owe(asked);
                    return;
                }
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
            if (owed.current !== 'none') {
                const again = owed.current === 'asked';
                owed.current = 'none';
                setRetry((last) => ({ count: last.count + 1, asked: again }));
            }
        }
    }

    // The owed save runs from the render after the first settled, so it sends what is held now.
    useEffect(() => {
        if (retry.count > 0) void save(retry.asked);
    }, [retry]);

    /** The one save a tab gets on its way out: fired and not waited on, because nothing waits. */
    function flush(): void {
        const { save: exit, sent } = exitSaveOf(state.revision, state.files, autosaveOf(state));
        const drafts = new Map(state.files.map((file) => [file.path, file]));
        // A tab that was only hidden comes back to the revision this landed as, or the next save
        // would name the one before it and lose to its own exit save as a conflict.
        const out: Promise<void> = api.saveOnExit(gameId, exit).then((workspace) => {
            if (workspace === undefined) return;
            adopt(workspace, sent, new Map(), drafts);
            if (!saving.current) setSaveState({ at: 'saved' });
        });
        exits.current.add(out);
        void out.finally(() => exits.current.delete(out));
    }

    const autosaved = useMemo(
        () => without(state.pending, state.held),
        [state.pending, state.held],
    );
    useAutosave({
        pending: autosaved,
        unsaved: isPending(state.pending),
        save: () => void save(false),
        flush,
    });
    useCrashFlush(isPending(autosaved) ? flush : undefined);

    // Coming back from signing in on the other tab is the moment a lapsed session is worth asking
    // about again: the read keeps the new token, and whatever is owed goes at once.
    useEffect(() => {
        const onVisible = (): void => {
            if (document.visibilityState !== 'visible' || !told.current) return;
            void api
                .session()
                .then((signedIn) => {
                    if (signedIn === undefined) return;
                    told.current = false;
                    setSaveState({ at: 'idle' });
                    setRetry((last) => ({ count: last.count + 1, asked: true }));
                })
                .catch(() => undefined);
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [api]);

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
        save: () => void save(true),
        edit,
        writeProject,
        addFile: (path) => {
            if (path === '' || state.files.some((file) => file.path === path)) return false;
            dispatch({ type: 'add', path });
            return true;
        },
        importFile: async (picked) => {
            const bytes = new Uint8Array(await picked.arrayBuffer());
            const draft = draftFromBytes(
                picked.name,
                bytes,
                importTypeOf(picked.name, picked.type),
            );
            dispatch({ type: 'import', draft });
            return draft.text !== undefined;
        },
        removeFile: (path) => dispatch({ type: 'remove', path }),
    };
}
