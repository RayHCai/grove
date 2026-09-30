import { useEffect, useReducer, useRef, useState } from 'react';
import { readThemeColors } from '@grove/ui';
import type { ProjectManifest } from '@platform/project';
import type { EditorHandle } from '../editor/monaco';
import { compile, summarize } from '../project/compile';
import type { LocalVersion } from '../project/compile';
import { sameStamp } from '../project/manifest';
import { transportReducer } from '../shell/Transport';
import type { TransportAction, TransportState } from '../shell/Transport';
import type { DraftFile } from '../workspace/files';
import { RUN_ENTRY, RunHost } from './host';
import type { LogLevel, RunLine } from './host';
import type { StageControls } from './LocalStage';

/** What the console keeps. A game in a loop writes faster than anyone reads. */
const MAX_LINES = 500;

/** The ground a run's own page is drawn on; it cannot read this one's stylesheet. */
function runColors(): { background: string; foreground: string } {
    const colors = readThemeColors();
    return { background: colors.surface || '#1b1916', foreground: colors.ink || '#e9e2d4' };
}

export interface RunOptions {
    files: readonly DraftFile[];
    project: ProjectManifest;
    /** The code editor, once it is in; it is the compiler a run goes through. */
    handle: EditorHandle | null;
    title: string;
    /** Writes back the manifest a compile stamped, when it differs from the one held. */
    writeProject: (project: ProjectManifest) => void;
}

export interface Run {
    lines: readonly RunLine[];
    clearLines: () => void;
    write: (level: LogLevel, text: string) => void;
    transport: TransportState;
    onTransport: (action: TransportAction) => void;
    /** The game a world is standing up for, or `null` when the stage is the sandbox's. */
    world: LocalVersion | null;
    /** The ref the sandbox's frame is handed through. */
    setFrame: (frame: HTMLIFrameElement | null) => void;
    /** Where a standing world hands its pause and resume, and takes them back when it goes. */
    setStage: (controls: StageControls | null) => void;
}

/**
 * Playing the game from here, and the console it writes to.
 *
 * Two stages answer to the same transport: a plain module graph runs in a sandboxed frame, and an
 * engine game stands a world up in this page. Which of them is up is what decides who hears it.
 */
export function useRun({ files, project, handle, title, writeProject }: RunOptions): Run {
    const [lines, setLines] = useState<readonly RunLine[]>([]);
    const lineId = useRef(0);
    const [transport, dispatchTransport] = useReducer(transportReducer, 'idle');
    // A new object per Play, because a world is built from what the code said when it was pressed.
    const [world, setWorld] = useState<LocalVersion | null>(null);
    const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
    const [host, setHost] = useState<RunHost | null>(null);
    const stage = useRef<StageControls | null>(null);

    function write(level: LogLevel, text: string): void {
        lineId.current += 1;
        const line = { id: lineId.current, level, text };
        setLines((held) => [...held, line].slice(-MAX_LINES));
    }

    useEffect(() => {
        const made = new RunHost({ onLine: (line) => write(line.level, line.text) });
        setHost(made);
        return () => {
            made.dispose();
            setHost(null);
        };
    }, []);

    useEffect(() => {
        host?.attach(frame);
    }, [host, frame]);

    async function start(): Promise<void> {
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
                `${problem.path}:${String(problem.line)}:${String(problem.column)}: ${problem.message}`,
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
            // The world runs here, in this tab, over a pair rather than a socket, so there is no
            // document to write into, and the stage is the only place it can play.
            setWorld(version);
            dispatchTransport('play');
            return;
        }

        const entry = RUN_ENTRY.replace(/\.ts$/u, '.js');
        if (!(entry in version.modules)) {
            write('error', `a run starts at ${RUN_ENTRY}, and this game has none`);
            return;
        }

        host.start(version.modules, entry, title, runColors());
        dispatchTransport('play');
    }

    function onTransport(action: TransportAction): void {
        if (action === 'stop') {
            host?.stop();
            setWorld(null);
            dispatchTransport('stop');
            return;
        }
        if (action === 'pause') {
            host?.pause();
            stage.current?.pause();
            dispatchTransport('pause');
            return;
        }
        if (transport === 'paused') {
            host?.resume();
            stage.current?.resume();
            dispatchTransport('play');
            return;
        }
        void start();
    }

    return {
        lines,
        clearLines: () => setLines([]),
        write,
        transport,
        onTransport,
        world,
        setFrame,
        setStage: (controls) => {
            stage.current = controls;
        },
    };
}
