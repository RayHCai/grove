import {
    Suspense,
    lazy,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react';
import { Tilestrip, readThemeColors } from '@grove/ui';
import type { WorkspaceFile } from '@grove/api-contract';
import type { ProjectManifest, ProjectSettings } from '@platform/project';
import type { Api } from '../api/client';
import { ApiError, isLapsedSession } from '../api/client';
import { ConsolePane } from '../console/ConsolePane';
import { EditorPane } from '../editor/EditorPane';
import type { EditorHandle } from '../editor/monaco';
import { initialTabs, tabsReducer } from '../editor/tabs';
import { ExplorerPanel } from '../explorer/ExplorerPanel';
import { compile, summarize } from '../project/compile';
import type { LocalVersion } from '../project/compile';
import { asProjectFile, treeOf } from '../project/files';
import {
    PROJECT_PATH,
    isProjectFile,
    projectDraft,
    sameStamp,
    withSettings,
} from '../project/manifest';
import { PlayPane } from '../player/PlayPane';
import { RUN_ENTRY, RunHost } from '../run/host';
import type { RunLine, Surface } from '../run/host';
import type { LocalStageProps, StageControls } from '../run/LocalStage';
import { SettingsPanel } from '../settings/SettingsPanel';
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
import { AiPanel } from './AiPanel';
import type { Mode } from './ModeSelect';
import { SideRail } from './SideRail';
import type { PanelId } from './SideRail';
import { TopBar } from './TopBar';
import type { SaveState } from './TopBar';
import { transportReducer } from './Transport';
import type { TransportAction } from './Transport';

// editor.css stretches the open panel over the whole workspace at this width; nothing under it stays reachable.
const COVERED_QUERY = '(max-width: 384px)';

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

/**
 * The stage an engine game plays on, fetched the first time somebody presses Play.
 *
 * Behind a `lazy` because it is the only thing in this app that reaches the engine, the sim and
 * the renderer — several megabytes a creator writing their first line has no use for yet.
 */
const LocalStage = lazy(async () => import('../run/LocalStage'));

export interface EditorShellProps {
    api: Api;
    opened: OpenGame;
    /**
     * Runs when the service stops recognising this session while the workbench is open.
     *
     * Whatever this does has to leave the screen standing: there is unsaved work here.
     */
    onSessionLapsed: () => void;
    /** How a local world's renderer is built; a test hands in one that needs no GPU. */
    createRenderer?: LocalStageProps['createRenderer'];
}

/** The workbench: top bar, rail, the Explorer and Grove AI panels, and the workspace of panes. */
export function EditorShell({
    api,
    opened,
    onSessionLapsed,
    createRenderer,
}: EditorShellProps): React.JSX.Element {
    const [panel, setPanel] = useState<PanelId | null>('files');
    const [mode, setMode] = useState<Mode>('ts');
    const [files, setFiles] = useState<readonly DraftFile[]>(opened.files);
    const [saved, setSaved] = useState<readonly WorkspaceFile[]>(opened.saved);
    const [revision, setRevision] = useState(opened.revision);
    // The manifest is one of the files; this is the same value parsed, so the gear edits it
    // without reparsing what it just wrote.
    const [project, setProject] = useState<ProjectManifest>(opened.project);
    // A template seeded in memory is owed to the service in full: nothing here has been saved, so
    // every path it carries is a path the first save has to send.
    const [pending, setPending] = useState<Pending>(() =>
        opened.seeded
            ? { upserted: new Set(opened.files.map((file) => file.path)), removed: new Set() }
            : NOTHING_PENDING,
    );
    const dirty = isPending(pending);
    const [state, setState] = useState<SaveState>({ at: 'idle' });
    // Autosave keeps trying as long as there is something unsaved, and every one of those tries
    // refuses the same way; without this, a lapsed session is an alert every few seconds.
    const told = useRef(false);
    const [lines, setLines] = useState<readonly RunLine[]>([]);
    const [handle, setHandle] = useState<EditorHandle | null>(null);
    const [transport, dispatchTransport] = useReducer(transportReducer, 'idle');
    // The game a world is standing up for, or `null` when the stage is the sandbox's. A new object
    // per Play, because a world is built from what the code said when the button was pressed.
    const [world, setWorld] = useState<LocalVersion | null>(null);

    // What the template said to open on if the game still has it, otherwise whatever is first; a
    // game with no sources at all opens on an empty strip rather than on a tab naming nothing.
    const opensOn = files.find((file) => file.path === opened.openPath)?.path;
    const first = opensOn ?? files.find((file) => !isProjectFile(file.path))?.path;
    const [tabs, dispatchTabs] = useReducer(tabsReducer, first, (path) =>
        path === undefined ? { open: [], active: null } : initialTabs(path),
    );

    const covered = useSyncExternalStore(subscribeCovered, workspaceCovered);
    const filesButtonRef = useRef<HTMLButtonElement>(null);
    const aiButtonRef = useRef<HTMLButtonElement>(null);
    const settingsButtonRef = useRef<HTMLButtonElement>(null);
    const filesPanelRef = useRef<HTMLElement>(null);
    const aiPanelRef = useRef<HTMLElement>(null);
    const settingsPanelRef = useRef<HTMLElement>(null);
    const frameRef = useRef<HTMLIFrameElement>(null);
    const runRef = useRef<RunHost | null>(null);
    const stageRef = useRef<StageControls | null>(null);
    // The Explorer is open on arrival, so only an opening the visitor asked for moves their focus.
    const focusOnOpen = useRef(false);
    const lineId = useRef(0);

    const buttonRefs = { files: filesButtonRef, ai: aiButtonRef, settings: settingsButtonRef };
    const panelRefs = { files: filesPanelRef, ai: aiPanelRef, settings: settingsPanelRef };

    // The manifest is not one of them: it is the gear's, and a tab open on it would be a creator
    // editing by hand what two other things write.
    const sources = useMemo(
        () => files.filter((file) => !isProjectFile(file.path)).map(asProjectFile),
        [files],
    );
    const tree = useMemo(() => treeOf(sources), [sources]);
    const byPath = useMemo(() => new Map(sources.map((file) => [file.path, file])), [sources]);

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
        handle?.syncFiles(sources);
    }, [handle, sources]);

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

    /** Writes the manifest into the game, where a save and a build both read it. */
    function writeProject(next: ProjectManifest): void {
        setProject(next);
        const draft = projectDraft(next);
        setFiles((held) =>
            held.some((file) => isProjectFile(file.path))
                ? held.map((file) => (isProjectFile(file.path) ? draft : file))
                : [...held, draft],
        );
        setPending((held) => touched(held, PROJECT_PATH));
        setState({ at: 'idle' });
    }

    function changeSettings(settings: ProjectSettings): void {
        writeProject(withSettings(project, settings));
    }

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
        setProject(current.project);
        setPending(NOTHING_PENDING);
        setState({
            at: 'failed',
            message: `somebody else saved this game; reloaded at revision ${String(current.revision)}`,
        });
    }

    /**
     * A session the service no longer recognises, reported once and left on the screen.
     *
     * Nothing is thrown away and nothing navigates: what was typed is still here, and signing in
     * elsewhere is what makes the next save land.
     */
    function lapsed(failure: unknown): boolean {
        if (!isLapsedSession(failure)) return false;
        if (!told.current) {
            told.current = true;
            onSessionLapsed();
        }
        setState({
            at: 'failed',
            message: 'your Grove session ended; sign in again, then save',
        });
        return true;
    }

    async function save(): Promise<void> {
        if (!dirty) return;
        setState({ at: 'saving' });
        try {
            setState({ at: 'saved', revision: await push() });
            // A save that landed is a session that answered, so the next lapse is a fresh one.
            told.current = false;
        } catch (failure) {
            if (lapsed(failure)) return;
            if (failure instanceof ApiError && failure.status === 409) {
                // The reload is a read against the same session, and can refuse the same way.
                await reload().catch((second: unknown) => {
                    if (!lapsed(second)) {
                        setState({ at: 'failed', message: messageOf(second) });
                    }
                });
                return;
            }
            setState({ at: 'failed', message: messageOf(failure) });
        }
    }

    /** The one save a tab gets on its way out: fired and not waited on, because nothing waits. */
    function flush(): void {
        void api.saveOnExit(opened.game.gameId, saveOf(revision, files, pending).save);
    }

    useAutosave({ pending, save: () => void save(), flush });

    async function startRun(surface: Surface): Promise<void> {
        const host = runRef.current;
        if (host === null) return;
        if (handle === null) {
            write('error', 'the editor is still loading');
            return;
        }

        setLines([]);
        lineId.current = 0;
        // Whatever was running is over before anything is built: one page holds one world, and a
        // compile that fails should still have stopped the game the creator pressed stop on.
        host.stop();
        setWorld(null);
        const { version, problems } = await compile({ files, project, emit: () => handle.emit() });
        for (const problem of problems) {
            write(
                problem.severity === 'error' ? 'error' : 'warn',
                `${problem.path}:${String(problem.line)}:${String(problem.column)} — ${problem.message}`,
            );
        }
        if (version === null) {
            write('error', 'that did not compile, so there is nothing to run');
            return;
        }

        write('log', summarize(version));
        // The compile is what stamps the classes and the digest, so what the file holds is what
        // the code declared as of this run rather than as of the last one.
        if (!sameStamp(version.project, project)) writeProject(version.project);

        if (version.needsEngine) {
            // The world runs here, in this tab, over a pair rather than a socket — so there is no
            // document to write into and no window to open one in.
            if (surface === 'window') {
                write('warn', 'a local world plays on the stage; use fullscreen for a bigger one');
            }
            setWorld(version);
            dispatchTransport('play');
            return;
        }

        const entry = RUN_ENTRY.replace(/\.ts$/u, '.js');
        if (!(entry in version.modules)) {
            write('error', `a run starts at ${RUN_ENTRY}, and this game has none`);
            return;
        }

        host.start(version.modules, entry, opened.game.title, runColors(), surface);
        dispatchTransport('play');
    }

    function onTransport(action: TransportAction): void {
        const host = runRef.current;
        // A world in this page and a run in a sandbox answer to the same three buttons; which of
        // them is on the stage is what decides who hears them.
        if (action === 'stop') {
            host?.stop();
            setWorld(null);
            dispatchTransport('stop');
            return;
        }
        if (action === 'pause') {
            host?.pause();
            stageRef.current?.pause();
            dispatchTransport('pause');
            return;
        }
        if (transport === 'paused') {
            host?.resume();
            stageRef.current?.resume();
            dispatchTransport('play');
            return;
        }
        void startRun('stage');
    }

    // `undefined` rather than `false` when there is no world: the play pane shows its frame only
    // when nothing was handed to it, and `false` is something.
    const stage =
        world === null ? undefined : (
            <Suspense
                fallback={
                    <div className="play-booting" role="status">
                        Loading the engine…
                    </div>
                }
            >
                <LocalStage
                    version={world}
                    name={opened.account.displayName}
                    onLine={write}
                    onControls={(controls) => {
                        stageRef.current = controls;
                    }}
                    createRenderer={createRenderer}
                />
            </Suspense>
        );

    return (
        <div className="shell">
            <Tilestrip />
            <TopBar
                title={opened.game.title}
                displayName={opened.account.displayName}
                dirty={dirty}
                state={state}
                onSave={() => void save()}
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
                <SettingsPanel
                    ref={settingsPanelRef}
                    open={panel === 'settings'}
                    project={project}
                    onChange={changeSettings}
                    onClose={closePanel}
                />
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
                            >
                                {stage}
                            </PlayPane>
                            <ConsolePane lines={lines} onClear={() => setLines([])} />
                        </div>
                    </div>
                </main>
            </div>
        </div>
    );
}
