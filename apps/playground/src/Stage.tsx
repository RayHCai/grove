// The canvas pane: owns the click -> spawn -> travel -> despawn loop.
//
// The drifter list is a REF, not state. It changes every frame, and re-rendering React 60 times a
// second to move a sprite would defeat the point — the renderer is already the thing that draws.
// React state here holds only what the HUD prints, and that is updated at most once per frame from
// a single counter object.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { NodeId } from '@platform/renderer';
import type { IRenderer } from '@platform/renderer';
import { useRenderer } from './use-renderer';
import { Inspector } from './Inspector';
import type { Drifter } from './sim';
import { DEFAULT_SPEED, DEFAULT_SPIN, spawnX, step } from './sim';

/** The reference stage. UI is authored against this, and `fit` letterboxes it (§3, §4.2). */
const DESIGN = { width: 960, height: 540 } as const;

/** The one asset this harness loads. Served from `public/`, so the URL is root-relative. */
const LEAF = 'leaf';

/** `leaf.png` is 16x16; scaled up so a pixel-art sprite is actually visible on a 960px stage. */
const LEAF_SCALE = 3;

/** Seconds between HUD publishes, which is also the fps averaging window. */
const HUD_INTERVAL = 0.5;

/** What the HUD shows. One object, mutated in place, copied into state to publish. */
interface Stats {
    live: number;
    spawned: number;
    retired: number;
    fps: number;
}

/**
 * Zoom levels the UI offers.
 *
 * Zooming IN shrinks the world viewport, which is what makes culling observable: a drifter still
 * travelling between the old edges is now outside the new ones, so §8 culls it and the inspector's
 * `cull` flag lights up. At zoom 1 the harness cannot cull at all — `EDGE_MARGIN` (32) is smaller
 * than the default `cullMargin` (64), so a spawned sprite always straddles the viewport edge.
 */
const ZOOMS = [1, 2, 4] as const;

export function Stage(): React.JSX.Element {
    const drifters = useRef<Array<Drifter<NodeId>>>([]);
    const stats = useRef<Stats>({ live: 0, spawned: 0, retired: 0, fps: 0 });
    const [hud, setHud] = useState<Stats>({ live: 0, spawned: 0, retired: 0, fps: 0 });
    const [zoom, setZoom] = useState(1);

    // A rolling mean over the last second, so the readout does not flicker on a single long frame.
    const fpsAccum = useRef({ frames: 0, elapsed: 0 });

    const onReady = useCallback(async (renderer: IRenderer) => {
        const result = await renderer.loadAssets([
            { name: LEAF, kind: 'image', url: '/leaf.png', filter: 'nearest' },
        ]);
        // `loadAssets` resolves with failures rather than rejecting, so one 404 must be surfaced
        // deliberately or it shows up as a silent magenta placeholder (§9.1).
        if (result.failed.length > 0) {
            const [failure] = result.failed;
            throw new Error(`could not load '${failure?.name}': ${failure?.reason}`);
        }
    }, []);

    const onFrame = useCallback((dt: number, renderer: IRenderer) => {
        const { alive, exited } = step(drifters.current, dt, renderer.viewport);

        if (exited.length > 0) {
            renderer.destroyNodes(exited.map((drifter) => drifter.id));
            stats.current.retired += exited.length;
        }
        drifters.current = alive;

        // One batched call for the whole population — the interface takes an array precisely so a
        // frame is a single crossing of the boundary (§11.1).
        if (alive.length > 0) {
            renderer.updateNodes(
                alive.map((drifter) => ({
                    id: drifter.id,
                    position: { x: drifter.x, y: drifter.y },
                    rotation: drifter.rotation,
                })),
            );
        }

        stats.current.live = alive.length;

        // The HUD publishes on the fps window, NOT every frame. `stats.current` is mutated 60
        // times a second; calling `setHud` that often would re-render React once per frame to
        // change a few digits, which is the cost this component is structured to avoid. Twice a
        // second is faster than anyone reads a counter.
        const fps = fpsAccum.current;
        fps.frames += 1;
        fps.elapsed += dt;
        if (fps.elapsed >= HUD_INTERVAL) {
            stats.current.fps = Math.round(fps.frames / fps.elapsed);
            fps.frames = 0;
            fps.elapsed = 0;
            // A fresh object, because React compares by identity — mutating `stats.current`
            // alone would never re-render.
            setHud({ ...stats.current });
        }
    }, []);

    const { containerRef, renderer, phase, error } = useRenderer({
        init: {
            design: DESIGN,
            // A shipped game allocates no editor containers; this harness is a game view.
            enabledSurfaces: ['world', 'ui'],
            background: 0x0f1a14,
            scaleMode: 'fit',
        },
        onReady,
        onFrame,
    });

    const spawn = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            if (renderer === null) return;

            // The click's world position — `screenToWorld` needs coordinates relative to the
            // CANVAS, so the container's own offset comes off first (§3: screen space is canvas
            // top-left, CSS px).
            const rect = event.currentTarget.getBoundingClientRect();
            const world = renderer.screenToWorld({
                x: event.clientX - rect.left,
                y: event.clientY - rect.top,
            });

            const viewport = renderer.viewport;
            const id = renderer.createNode({
                kind: 'sprite',
                texture: LEAF,
                surface: 'world',
                // Enters off the left edge at the clicked height, then crosses to the right.
                position: { x: spawnX(viewport), y: world.y },
                scale: { x: LEAF_SCALE, y: LEAF_SCALE },
                layer: 10,
            });

            // A smaller sprite parented to the leaf: it follows the leaf's POSITION but inherits
            // neither its rotation nor its scale (§5). Only the parent is stepped, so this also
            // gives the inspector a real two-level tree — and makes it obvious in the panel that
            // the child's `local` and `resolved` positions differ while its rotation stays 0.
            renderer.createNode({
                kind: 'sprite',
                texture: LEAF,
                surface: 'world',
                parent: id,
                position: { x: 0, y: 34 },
                scale: { x: 1, y: 1 },
                alpha: 0.55,
                layer: 11,
            });

            drifters.current.push({
                id,
                x: spawnX(viewport),
                y: world.y,
                speed: DEFAULT_SPEED,
                rotation: 0,
                spin: DEFAULT_SPIN,
            });
            stats.current.spawned += 1;
            stats.current.live = drifters.current.length;
            // Published immediately rather than waiting for the frame-loop window: a click whose
            // counter does not move for half a second reads as a dropped click.
            setHud({ ...stats.current });
        },
        [renderer],
    );

    const clear = useCallback(() => {
        if (renderer === null) return;
        renderer.destroyNodes(drifters.current.map((drifter) => drifter.id));
        stats.current.retired += drifters.current.length;
        drifters.current = [];
        stats.current.live = 0;
        setHud({ ...stats.current });
    }, [renderer]);

    // The camera is renderer state, not React state, so it is pushed in an effect rather than in
    // the change handler — that way a renderer that becomes ready later still gets the current
    // zoom, instead of silently keeping 1.
    useEffect(() => {
        renderer?.setCamera({ position: { x: 0, y: 0 }, zoom });
    }, [renderer, zoom]);

    return (
        <div className="stage">
            <div
                className="stage__canvas"
                ref={containerRef}
                onPointerDown={spawn}
                role="presentation"
            />

            <div className="stage__hud">
                <span className={`badge badge--${phase}`}>{phase}</span>
                <span>live {hud.live}</span>
                <span>spawned {hud.spawned}</span>
                <span>retired {hud.retired}</span>
                <span>{hud.fps} fps</span>

                <label className="stage__zoom">
                    zoom
                    <select
                        aria-label="camera zoom"
                        value={zoom}
                        onChange={(e) => setZoom(Number(e.target.value))}
                        disabled={renderer === null}
                    >
                        {ZOOMS.map((z) => (
                            <option key={z} value={z}>
                                {z}x
                            </option>
                        ))}
                    </select>
                </label>

                <button type="button" onClick={clear} disabled={renderer === null}>
                    clear
                </button>
            </div>

            {phase === 'failed' && <p className="stage__error">{error?.message}</p>}

            <Inspector renderer={renderer} />
        </div>
    );
}
