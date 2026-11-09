import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import type { Api } from '../api/client';
import { profileUrl } from '../boot/platform';
import { ConsoleLines } from '../console/lines';
import { ConsolePane } from '../console/ConsolePane';
import { EditorPane } from '../editor/EditorPane';
import type { EditorHandle } from '../editor/monaco';
import { initialTabs, tabsReducer } from '../editor/tabs';
import { ExplorerPanel } from '../explorer/ExplorerPanel';
import { asProjectFile, treeOf } from '../project/files';
import { isProjectFile, withSettings } from '../project/manifest';
import { PlayPane } from '../player/PlayPane';
import { useRun } from '../run/useRun';
import { SettingsPanel } from '../settings/SettingsPanel';
import type { DraftFile } from '../workspace/files';
import { UNFINISHED } from '../unfinished';
import type { OpenGame } from '../workspace/session';
import { useWorkspace } from '../workspace/useWorkspace';
import { AiPanel } from './AiPanel';
import { SideRail } from './SideRail';
import type { PanelId } from './SideRail';
import { TopBar } from './TopBar';

// editor.css stretches the open panel over the whole workspace at this width; nothing under it stays reachable.
const COVERED_QUERY = '(max-width: 384px)';

function subscribeCovered(onChange: () => void): () => void {
    if (typeof window.matchMedia !== 'function') return () => undefined;
    const query = window.matchMedia(COVERED_QUERY);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
}

function workspaceCovered(): boolean {
    return typeof window.matchMedia === 'function' && window.matchMedia(COVERED_QUERY).matches;
}

/**
 * The files the code editor holds: every one but the manifest, which is the gear's, and a tab
 * open on it would be a creator editing by hand what two other things write.
 */
function sourcesOf(files: readonly DraftFile[]): ReturnType<typeof asProjectFile>[] {
    return files.filter((file) => !isProjectFile(file.path)).map(asProjectFile);
}

export interface EditorShellProps {
    api: Api;
    opened: OpenGame;
    /**
     * Runs when the service stops recognising this session while the workbench is open.
     *
     * Whatever this does has to leave the screen standing: there is unsaved work here.
     */
    onSessionLapsed: () => void;
}

/** The workbench: top bar, rail, the Explorer and Grove AI panels, and the workspace of panes. */
export function EditorShell({ api, opened, onSessionLapsed }: EditorShellProps): React.JSX.Element {
    const [handle, setHandle] = useState<EditorHandle | null>(null);
    // Held, never subscribed to here: only the console pane redraws when a run writes.
    const [lines] = useState(() => new ConsoleLines());
    const workspace = useWorkspace({
        api,
        opened,
        onSessionLapsed,
        onReloaded: (files) => handle?.resetFiles(sourcesOf(files)),
    });
    const run = useRun({
        files: workspace.files,
        project: workspace.project,
        handle,
        title: opened.game.title,
        name: opened.account.displayName,
        lines,
        writeProject: workspace.writeProject,
    });

    // What the template said to open on if the game still has it, otherwise whatever is first; a
    // game with no sources at all opens on an empty strip rather than on a tab naming nothing.
    const [tabs, dispatchTabs] = useReducer(tabsReducer, opened, (game) => {
        const first =
            game.files.find((file) => file.path === game.openPath)?.path ??
            game.files.find((file) => !isProjectFile(file.path))?.path;
        return first === undefined ? { open: [], active: null } : initialTabs(first);
    });

    const [panel, setPanel] = useState<PanelId | null>('files');
    const covered = useSyncExternalStore(subscribeCovered, workspaceCovered);
    const filesButtonRef = useRef<HTMLButtonElement>(null);
    const aiButtonRef = useRef<HTMLButtonElement>(null);
    const settingsButtonRef = useRef<HTMLButtonElement>(null);
    const filesPanelRef = useRef<HTMLElement>(null);
    const aiPanelRef = useRef<HTMLElement>(null);
    const settingsPanelRef = useRef<HTMLElement>(null);
    // The Explorer is open on arrival, so only an opening the visitor asked for moves their focus.
    const focusOnOpen = useRef(false);

    const buttonRefs = { files: filesButtonRef, ai: aiButtonRef, settings: settingsButtonRef };
    const panelRefs = { files: filesPanelRef, ai: aiPanelRef, settings: settingsPanelRef };

    const sources = useMemo(() => sourcesOf(workspace.files), [workspace.files]);
    const tree = useMemo(() => treeOf(sources), [sources]);
    const byPath = useMemo(() => new Map(sources.map((file) => [file.path, file])), [sources]);

    // Every file, not only the open tabs: the checker and the emitter are a program over all of
    // them, and a file with no model is a module a local run would be missing.
    useEffect(() => {
        handle?.syncFiles(sources);
    }, [handle, sources]);

    const edit = workspace.edit;
    useEffect(() => {
        handle?.onChange(edit);
    }, [handle, edit]);

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

    function addFile(path: string): void {
        if (workspace.addFile(path)) dispatchTabs({ type: 'open', path });
    }

    async function importFile(picked: File): Promise<void> {
        if (await workspace.importFile(picked)) dispatchTabs({ type: 'open', path: picked.name });
    }

    function removeFile(path: string): void {
        workspace.removeFile(path);
        dispatchTabs({ type: 'close', path });
    }

    return (
        <div className="shell">
            <TopBar
                title={opened.game.title}
                displayName={opened.account.displayName}
                dirty={workspace.dirty}
                state={workspace.saveState}
                onSave={workspace.save}
                profileHref={profileUrl()}
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
                {UNFINISHED && (
                    <AiPanel ref={aiPanelRef} open={panel === 'ai'} onClose={closePanel} />
                )}
                <SettingsPanel
                    ref={settingsPanelRef}
                    open={panel === 'settings'}
                    project={workspace.project}
                    onChange={(settings) =>
                        workspace.writeProject(withSettings(workspace.project, settings))
                    }
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
                        />
                        <div className="workspace__side">
                            <PlayPane
                                status={run.transport}
                                dispatch={run.onTransport}
                                frameRef={run.setFrame}
                                stageStatus={run.stage}
                            />
                            <ConsolePane lines={lines} />
                        </div>
                    </div>
                </main>
            </div>
        </div>
    );
}
