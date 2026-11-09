import { useEffect, useReducer, useState } from 'react';
import { readThemeColors } from '@grove/ui';
import type { ProjectManifest } from '@platform/project';
import type { ConsoleLines } from '../console/lines';
import type { EditorHandle } from '../editor/monaco';
import { compile, summarize } from '../project/compile';
import { sameStamp } from '../project/manifest';
import { transportReducer } from '../shell/Transport';
import type { TransportAction, TransportState } from '../shell/Transport';
import type { DraftFile } from '../workspace/files';
import { servedAssets } from './assets';
import { PreviewHost, RUN_ENTRY } from './host';
import type { StageColors, StageStatus } from './protocol';

/** The ground a run's own document is drawn on; it cannot read this one's stylesheet. */
function runColors(): StageColors {
    const colors = readThemeColors();
    return { background: colors.surface || '#1b1916', foreground: colors.ink || '#e9e2d4' };
}

export interface RunOptions {
    files: readonly DraftFile[];
    project: ProjectManifest;
    /** The code editor, once it is in; it is the compiler a run goes through. */
    handle: EditorHandle | null;
    title: string;
    /** The creator, as the other peers in a world would see them. */
    name: string;
    /** Where what a run writes goes; held outside React, so writing re-renders nothing here. */
    lines: ConsoleLines;
    /** Writes back the manifest a compile stamped, when it differs from the one held. */
    writeProject: (project: ProjectManifest) => void;
}

export interface Run {
    transport: TransportState;
    onTransport: (action: TransportAction) => void;
    /** Where the stage's document has got to, or `null` while nothing is on it. */
    stage: StageStatus | null;
    /** The ref the stage's frame is handed through. */
    setFrame: (frame: HTMLIFrameElement | null) => void;
}

/**
 * Playing the game from here.
 *
 * Both kinds of game run in a sandboxed document with an origin of its own: a plain module graph,
 * and a world with the engine under it. Nothing a creator wrote is evaluated in this page.
 */
export function useRun({
    files,
    project,
    handle,
    title,
    name,
    lines,
    writeProject,
}: RunOptions): Run {
    const [transport, dispatchTransport] = useReducer(transportReducer, 'idle');
    const [stage, setStage] = useState<StageStatus | null>(null);
    const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
    const [host, setHost] = useState<PreviewHost | null>(null);

    useEffect(() => {
        const made = new PreviewHost({
            onLine: (level, text) => lines.write(level, text),
            onStatus: setStage,
        });
        setHost(made);
        return () => {
            made.dispose();
            setHost(null);
        };
    }, [lines]);

    useEffect(() => {
        host?.attach(frame);
    }, [host, frame]);

    async function start(): Promise<void> {
        if (host === null) return;
        if (handle === null) {
            lines.write('error', 'the editor is still loading');
            return;
        }

        lines.clear();
        // Whatever was running is over before anything is built, so a compile that fails has still
        // stopped the game the creator pressed stop on.
        host.stop();
        setStage(null);
        const { version, problems } = await compile({ files, project, emit: () => handle.emit() });
        for (const problem of problems) {
            lines.write(
                problem.severity === 'error' ? 'error' : 'warn',
                `${problem.path}:${String(problem.line)}:${String(problem.column)}: ${problem.message}`,
            );
        }
        if (version === null) {
            lines.write('error', 'that did not compile, so there is nothing to run');
            return;
        }

        lines.write('log', summarize(version));
        // The compile is what stamps the classes and the digest, so what the file holds is what
        // the code declared as of this run rather than as of the last one.
        if (!sameStamp(version.project, project)) writeProject(version.project);

        if (version.needsEngine) {
            host.start({
                mode: 'world',
                modules: version.modules,
                project: version.project,
                name,
                colors: runColors(),
                assets: await servedAssets(version.project),
            });
            dispatchTransport('play');
            return;
        }

        const entry = RUN_ENTRY.replace(/\.ts$/u, '.js');
        if (!(entry in version.modules)) {
            lines.write('error', `a run starts at ${RUN_ENTRY}, and this game has none`);
            return;
        }
        host.start({ mode: 'plain', modules: version.modules, entry, title, colors: runColors() });
        dispatchTransport('play');
    }

    function onTransport(action: TransportAction): void {
        if (action === 'stop') {
            host?.stop();
            setStage(null);
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
        void start();
    }

    return { transport, onTransport, stage, setFrame };
}
