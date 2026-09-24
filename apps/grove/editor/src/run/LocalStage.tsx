// The stage an engine game plays on: a world booted in this tab, and a session mounted against it.
//
// Lazily imported, and the only module in the editor that reaches the engine, the sim or the
// renderer at run time — a creator who never presses Play never downloads a line of it.

import { useEffect, useRef, useState } from 'react';
import { DESIGN_STAGE, GamePlayer } from '@grove/player';
import type { GamePlayerProps } from '@grove/player';
import { bootPreview } from '@grove/player/preview';
import type { Preview } from '@grove/player/preview';
import * as Engine from '@platform/engine';
import { linkVersion } from '../project/link';
import type { LinkedGame } from '../project/link';
import type { LocalVersion } from '../project/compile';
import type { LogLevel } from './host';
import { renderLine } from './render';

/** What the transport bar reaches a running world through. */
export interface StageControls {
    pause: () => void;
    resume: () => void;
}

export interface LocalStageProps {
    /** The game to stand up. A new object is a new world; the same one is left running. */
    version: LocalVersion;
    /** The creator, as the other peers in this world would see them. */
    name: string;
    onLine: (level: LogLevel, text: string) => void;
    /** Handed the controls when the world is up, and `null` when it goes. */
    onControls: (controls: StageControls | null) => void;
    /** How the session's renderer is built; a test hands in one that needs no GPU. */
    createRenderer?: GamePlayerProps['createRenderer'] | undefined;
}

/**
 * One page, one world.
 *
 * The engine keeps its runtime in a single module-level slot, so a second `createSim` while a
 * first world is live leaves that first world reading a runtime that is not its own. Every boot
 * and every teardown is queued through here, which is also what makes StrictMode's
 * mount-teardown-mount safe: the abandoned boot finishes and is disposed before the next begins.
 */
let worlds: Promise<unknown> = Promise.resolve();

function queue<T>(work: () => Promise<T>): Promise<T> {
    const next = worlds.then(work);
    // The chain never rejects, so one boot that threw cannot strand every boot after it.
    worlds = next.then(
        () => undefined,
        () => undefined,
    );
    return next;
}

/** A world standing up, and everything holding it up, so a teardown can let go of all of it. */
interface Standing {
    preview: Preview;
    linked: LinkedGame;
}

export function LocalStage({
    version,
    name,
    onLine,
    onControls,
    createRenderer,
}: LocalStageProps): React.JSX.Element {
    const [preview, setPreview] = useState<Preview | null>(null);

    // Read through refs so a parent may pass fresh closures every render without tearing down a
    // world that is running perfectly well.
    const lineRef = useRef(onLine);
    lineRef.current = onLine;
    const controlsRef = useRef(onControls);
    controlsRef.current = onControls;

    useEffect(() => {
        const mounted = { live: true };

        const standing = queue(async (): Promise<Standing | null> => {
            if (!mounted.live) return null;
            let linked: LinkedGame | null = null;
            try {
                linked = await linkVersion(version, {
                    engine: Engine as unknown as Record<string, unknown>,
                    console: {
                        log: (...values) => lineRef.current('log', renderLine(values)),
                        info: (...values) => lineRef.current('log', renderLine(values)),
                        warn: (...values) => lineRef.current('warn', renderLine(values)),
                        error: (...values) => lineRef.current('error', renderLine(values)),
                    },
                });
                if (!mounted.live) {
                    linked.dispose();
                    return null;
                }
                const booted = bootPreview({
                    project: version.project,
                    scripts: linked.scripts,
                    onLog: (line) => lineRef.current('warn', line),
                });
                if (!mounted.live) {
                    booted.dispose();
                    linked.dispose();
                    return null;
                }
                return { preview: booted, linked };
            } catch (failure) {
                linked?.dispose();
                lineRef.current('error', messageOf(failure));
                return null;
            }
        });

        void standing.then((up) => {
            if (!mounted.live || up === null) return;
            setPreview(up.preview);
            controlsRef.current({ pause: up.preview.pause, resume: up.preview.resume });
        });

        return () => {
            mounted.live = false;
            controlsRef.current(null);
            setPreview(null);
            // Queued behind the boot rather than run here: a world still being stood up has
            // nothing to tear down yet, and the next boot must not start until this one has gone.
            void queue(async () => {
                const up = await standing;
                up?.preview.dispose();
                up?.linked.dispose();
            });
        };
    }, [version]);

    if (preview === null) {
        return (
            <div className="play-booting" role="status">
                Starting the world…
            </div>
        );
    }

    return (
        <GamePlayer
            authority={preview.authority}
            project={preview.project}
            name={name}
            design={DESIGN_STAGE}
            onRefused={(_reason, message) => lineRef.current('error', message)}
            {...(createRenderer === undefined ? {} : { createRenderer })}
        />
    );
}

function messageOf(failure: unknown): string {
    return failure instanceof Error ? failure.message : String(failure);
}

export default LocalStage;
