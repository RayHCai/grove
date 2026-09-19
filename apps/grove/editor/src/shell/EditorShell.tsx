import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { Tilestrip, readThemeColors } from '@grove/ui';
import type { WorkspaceFile } from '@grove/api-contract';
import type { Api } from '../api/client';
import { ApiError } from '../api/client';
import { ConsolePane } from '../console/ConsolePane';
import { EditorPane } from '../editor/EditorPane';
import type { EditorHandle } from '../editor/monaco';
import { initialTabs, tabsReducer } from '../editor/tabs';
import { ExplorerPanel } from '../explorer/ExplorerPanel';
import { asProjectFile, treeOf } from '../project/files';
import { PlayPane } from '../player/PlayPane';
import { RunHost } from '../run/host';
import type { RunLine, Surface } from '../run/host';
import { useAutosave } from '../workspace/autosave';
import {
    NOTHING_PENDING,
    draftFromBytes,
    draftFromText,
    dropped,
    isPending,
    isText,
    mediaTypeOf,
    touched,
} from '../workspace/files';
import type { DraftFile, Pending } from '../workspace/files';
import { reloadGame, saveGame, saveOf } from '../workspace/session';
import type { OpenGame } from '../workspace/session';
import { ENTRY_PATH } from '../workspace/template';
import { AiPanel } from './AiPanel';
import type { Mode } from './ModeSelect';
import { SideRail } from './SideRail';
import type { PanelId } from './SideRail';
import { TopBar } from './TopBar';
import type { SaveState } from './TopBar';
import { transportReducer } from './Transport';
import type { TransportAction } from './Transport';

// editor.css stretches the open panel over the whole workspace at this width; nothing under it stays reachable.
const COVERED_QUERY = '(max-width: 480px)';

/** What the console keeps. A game in a loop writes faster than anyone reads. */
const MAX_LINES = 500;

function subscribeCovered(onChange: () => void): () => void {
    if (typeof window.matchMedia !== 'function') return () => undefined;
    const query = window.matchMedia(COVERED_QUERY);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
}

function workspaceCovered(): boolean {
    return typeof window.matchMedia === 'function' && window.matchMedia(COVERED_QUERY).matches;
}

function messageOf(failure: unknown): string {
    return failure instanceof ApiError ? failure.message : 'something went wrong';
}

/** The ground a run's own page is drawn on; it cannot read this one's stylesheet. */
function runColors(): { background: string; foreground: string } {
    const colors = readThemeColors();
    return { background: colors.surface || '#1b1916', foreground: colors.ink || '#e9e2d4' };
}

export interface EditorShellProps {
    api: Api;
    opened: OpenGame;
    /** Runs when the session ends, which is what puts the sign-in form back. */
    onSignedOut: () => void;
}

/** The workbench: top bar, rail, the Explorer and Grove AI panels, and the workspace of panes. */
export function EditorShell({ api, opened, onSignedOut }: EditorShellProps): React.JSX.Element {
    const [panel, setPanel] = useState<PanelId | null>('files');
    const [mode, setMode] = useState<Mode>('ts');
    const [files, setFiles] = useState<readonly DraftFile[]>(opened.files);
    const [saved, setSaved] = useState<readonly WorkspaceFile[]>(opened.saved);
    const [revision, setRevision] = useState(opened.revision);
    // A template seeded in memory is owed to the service in full: nothing here has been saved, so
    // every path it carries is a path the first save has to send.
    const [pending, setPending] = useState<Pending>(() =>
        opened.seeded
            ? { upserted: new Set(opened.files.map((file) => file.path)), removed: new Set() }
            : NOTHING_PENDING,
    );
    const dirty = isPending(pending);
    const [state, setState] = useState<SaveState>({ at: 'idle' });
    const [lines, setLines] = useState<readonly RunLine[]>([]);
    const [handle, setHandle] = useState<EditorHandle | null>(null);
    const [transport, dispatchTransport] = useReducer(transportReducer, 'idle');

    // The entry if the game has one, otherwise whatever is first; a game with no files at all
    // opens on an empty strip rather than on a tab naming nothing.
    const first = files.find((file) => file.path === ENTRY_PATH)?.path ?? files[0]?.path;
    const [tabs, dispatchTabs] = useReducer(tabsReducer, first, (path) =>
        path === undefined ? { open: [], active: null } : initialTabs(path),
    );

    const covered = useSyncExternalStore(subscribeCovered, workspaceCovered);
    const filesButtonRef = useRef<HTMLButtonElement>(null);
    const aiButtonRef = useRef<HTMLButtonElement>(null);
    const filesPanelRef = useRef<HTMLElement>(null);
    const aiPanelRef = useRef<HTMLElement>(null);
    const frameRef = useRef<HTMLIFrameElement>(null);
    const runRef = useRef<RunHost | null>(null);
    // The Explorer is open on arrival, so only an opening the visitor asked for moves their focus.
    const focusOnOpen = useRef(false);
    const lineId = useRef(0);

    const buttonRefs = { files: filesButtonRef, ai: aiButtonRef };
    const panelRefs = { files: filesPanelRef, ai: aiPanelRef };

    const project = useMemo(() => files.map(asProjectFile), [files]);
    const tree = useMemo(() => treeOf(project), [project]);
    const byPath = useMemo(() => new Map(project.map((file) => [file.path, file])), [project]);

    function write(level: RunLine['level'], text: string): void {
        lineId.current += 1;
        const line = { id: lineId.current, level, text };
        setLines((held) => [...held, line].slice(-MAX_LINES));
    }

    useEffect(() => {
        const host = new RunHost({ onLine: (line) => write(line.level, line.text) });
        runRef.current = host;
        return () => {
            host.dispose();
            runRef.current = null;
        };
    }, []);

    useEffect(() => {
        runRef.current?.attach(frameRef.current);
    });

    // Every file, not only the open tabs: the checker and the emitter are a program over all of
    // them, and a file with no model is a module a local run would be missing.
    useEffect(() => {
        handle?.syncFiles(project);
    }, [handle, project]);

    useEffect(() => {
        handle?.onChange((path, text) => {
            setFiles((held) =>
                held.map((file) =>
                    // An asset has no text to replace; the tab opened on one shows a description.
                    file.path === path && file.text !== undefined ? { ...file, text } : file,
                ),
            );
            setPending((held) => touched(held, path));
            setState({ at: 'idle' });
        });
    }, [handle]);

    useEffect(() => {
        if (!focusOnOpen.current || panel === null) return;
        focusOnOpen.current = false;
        // The refs are stable, so the open panel is the only thing this effect answers to.
        panelRefs[panel].current?.focus();
    }, [panel]);

    function closePanel(): void {
        if (panel === null) return;
        const opener = buttonRefs[panel];
        setPanel(null);
        opener.current?.focus();
    }

    function togglePanel(next: PanelId): void {
        if (panel === next) {
            closePanel();
            return;
        }
        focusOnOpen.current = true;
        setPanel(next);
    }

    // ---- the files themselves

    function addFile(path: string): void {
        if (path === '' || files.some((file) => file.path === path)) return;
        setFiles((held) => [...held, draftFromText(path, '')]);
        setPending((held) => touched(held, path));
        dispatchTabs({ type: 'open', path });
    }

    async function importFile(picked: File): Promise<void> {
        const bytes = new Uint8Array(await picked.arrayBuffer());
        const type = picked.type === '' ? mediaTypeOf(picked.name) : picked.type;
        setFiles((held) => [
            ...held.filter((file) => file.path !== picked.name),
            draftFromBytes(picked.name, bytes, type),
        ]);
        setPending((held) => touched(held, picked.name));
        if (isText(type)) dispatchTabs({ type: 'open', path: picked.name });
    }

    function removeFile(path: string): void {
        setFiles((held) => held.filter((file) => file.path !== path));
        // Only a path the service has heard of becomes a delete: one made and removed between two
        // saves is dropped from both sides instead.
        setPending((held) =>
            dropped(
                held,
                path,
                saved.some((file) => file.path === path),
            ),
        );
        dispatchTabs({ type: 'close', path });
    }

    // ---- saving, and what a publish does first

    async function push(): Promise<number> {
        // Captured before the request: a keystroke landing while it is in flight belongs to the
        // next save, and clearing the whole set afterwards would swallow it.
        const sent = pending;
        const next = await saveGame(api, opened.game.gameId, revision, files, sent);
        setRevision(next.revision);
        setSaved(next.files);
        setPending((held) => ({
            upserted: new Set([...held.upserted].filter((path) => !sent.upserted.has(path))),
            removed: new Set([...held.removed].filter((path) => !sent.removed.has(path))),
        }));
        return next.revision;
    }

    /**
     * Throws away what is on this screen and takes what the service holds.
     *
     * A second editor claimed this revision, so there is no set here to merge into: warning and
     * reloading is the honest answer, where saving over it would be one creator silently
     * overwriting the other.
     */
    async function reload(): Promise<void> {
        const current = await reloadGame(api, opened.game.gameId);
        setRevision(current.revision);
        setSaved(current.saved);
        setFiles(current.files);
        setPending(NOTHING_PENDING);
        setState({
            at: 'failed',
            message: `somebody else saved this game; reloaded at revision ${String(current.revision)}`,
        });
    }

    async function save(): Promise<void> {
        if (!dirty) return;
        setState({ at: 'saving' });
        try {
            setState({ at: 'saved', revision: await push() });
        } catch (failure) {
            if (failure instanceof ApiError && failure.status === 409) {
                await reload();
                return;
            }
            setState({ at: 'failed', message: messageOf(failure) });
        }
    }

    /** The one save a tab gets on its way out: fired and not waited on, because nothing waits. */
    function flush(): void {
        void api.saveOnExit(opened.game.gameId, saveOf(revision, files, pending).save);
    }

    async function publish(): Promise<void> {
        setState({ at: 'publishing' });
        try {
            // The files go first, always: a publish builds the manifest the last save froze, so
            // publishing without pushing would build the version before this one.
            if (dirty) await push();
            const task = await api.publish(opened.game.gameId);
            setState({ at: 'published', revision: task.manifestRevision });
        } catch (failure) {
            setState({ at: 'failed', message: messageOf(failure) });
        }
    }

    useAutosave({ pending, save: () => void save(), flush });

    async function signOut(): Promise<void> {
        // The in-app exit `beforeunload` never sees: the page is not going anywhere, so what is
        // unsaved has to be saved here or it is gone with the session.
        if (dirty) await save();
        try {
            await api.signOut();
        } finally {
            onSignedOut();
        }
    }

    // ---- the local run

    async function startRun(surface: Surface): Promise<void> {
        const host = runRef.current;
        if (host === null) return;
        if (handle === null) {
            write('error', 'the editor is still loading');
            return;
        }

        setLines([]);
        lineId.current = 0;
        const { modules, problems } = await handle.emit();
        for (const problem of problems) {
            write(
                problem.severity === 'error' ? 'error' : 'warn',
                `${problem.path}:${String(problem.line)}:${String(problem.column)} — ${problem.message}`,
            );
        }
        // A wrong type still compiles to something that runs; a broken parse does not.
        if (problems.some((problem) => problem.syntactic)) {
            write('error', 'that did not compile, so there is nothing to run');
            return;
        }

        const entry = ENTRY_PATH.replace(/\.ts$/u, '.js');
        if (!(entry in modules)) {
            write('error', `a run starts at ${ENTRY_PATH}, and this game has none`);
            return;
        }

        host.start(modules, entry, opened.game.title, runColors(), surface);
        dispatchTransport('play');
    }

    function onTransport(action: TransportAction): void {
        const host = runRef.current;
        if (action === 'stop') {
            host?.stop();
            dispatchTransport('stop');
            return;
        }
        if (action === 'pause') {
            host?.pause();
            dispatchTransport('pause');
            return;
        }
        if (transport === 'paused') {
            host?.resume();
            dispatchTransport('play');
            return;
        }
        void startRun('stage');
    }

    return (
        <div className="shell">
            <Tilestrip />
            <TopBar
                title={opened.game.title}
                displayName={opened.account.displayName}
                dirty={dirty}
                state={state}
                onSave={() => void save()}
                onPublish={() => void publish()}
                onSignOut={() => void signOut()}
            />
            <div className="shell__body">
                <SideRail panel={panel} onToggle={togglePanel} buttonRefs={buttonRefs} />
                <ExplorerPanel
                    ref={filesPanelRef}
                    open={panel === 'files'}
                    projectName={opened.game.title}
                    nodes={tree}
                    activePath={tabs.active}
                    onOpenFile={(file) => dispatchTabs({ type: 'open', path: file.path })}
                    onAddFile={addFile}
                    onImportFile={(picked) => void importFile(picked)}
                    onRemoveFile={removeFile}
                    onClose={closePanel}
                />
                <AiPanel ref={aiPanelRef} open={panel === 'ai'} onClose={closePanel} />
                <main className="workspace" inert={panel !== null && covered}>
                    <div className="workspace__grid">
                        <EditorPane
                            files={tabs.open.flatMap((path) => byPath.get(path) ?? [])}
                            activePath={tabs.active}
                            onSelect={(path) => dispatchTabs({ type: 'select', path })}
                            onClose={(path) => dispatchTabs({ type: 'close', path })}
                            onReady={setHandle}
                            mode={mode}
                            onModeChange={setMode}
                        />
                        <div className="workspace__side">
                            <PlayPane
                                status={transport}
                                dispatch={onTransport}
                                frameRef={frameRef}
                                onOpenWindow={() => void startRun('window')}
                            />
                            <ConsolePane lines={lines} onClear={() => setLines([])} />
                        </div>
                    </div>
                </main>
            </div>
        </div>
    );
}
