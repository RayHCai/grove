// The canvas pane: owns the click -> spawn -> travel -> despawn loop, now driven by a real
// @platform/core game.
//
// THE SIM IS THE SOURCE OF TRUTH. Each leaf is a core Entity advanced by a fixed-step Loop
// (see game.ts); the renderer only MIRRORS where the entities are. Per frame we advance the
// loop, reap entities that left the stage, and push every live entity's transform to its
// renderer node. React state here holds only what the HUD prints — re-rendering React 60
// times a second to move a sprite would defeat the point, since the renderer already draws.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { NodeId } from '@platform/renderer';
import type { IRenderer } from '@platform/renderer';
import type { EntityId } from '@platform/core';
import type { LoopStats } from './game';
import { useRenderer } from './use-renderer';
import { Inspector } from './Inspector';
import { LoopPanel } from './LoopPanel';
import { DEFAULT_SPEED, DEFAULT_SPIN, LeafGame, exitX, spawnX } from './game';

/** The reference stage. UI is authored against this, and `fit` letterboxes it (§3, §4.2). */
const DESIGN = { width: 960, height: 540 } as const;

/** Ticks per simulated second. The fixed timestep the Loop advances by is `1 / SIM_RATE`. */
const SIM_RATE = 60;

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
 * Zooming IN shrinks the world viewport, which is what makes culling observable: a leaf still
 * travelling between the old edges is now outside the new ones, so §8 culls it and the
 * inspector's `cull` flag lights up. At zoom 1 the harness cannot cull at all — `EDGE_MARGIN`
 * (32) is smaller than the default `cullMargin` (64), so a spawned sprite always straddles the
 * viewport edge.
 */
const ZOOMS = [1, 2, 4] as const;

export function Stage(): React.JSX.Element {
    // The core game lives in a ref for the same reason the renderer does: it is a mutable
    // object whose identity never changes, and the frame loop reads it without re-rendering.
    const gameRef = useRef<LeafGame | null>(null);
    // Maps a core entity to the renderer node mirroring it. The renderer's parented shadow
    // sprite is NOT in here — destroying the leaf node cascades to it (§5, renderer core).
    const nodeFor = useRef<Map<EntityId, NodeId>>(new Map());

    const stats = useRef<Stats>({ live: 0, spawned: 0, retired: 0, fps: 0 });
    const [hud, setHud] = useState<Stats>({ live: 0, spawned: 0, retired: 0, fps: 0 });
    const [zoom, setZoom] = useState(1);

    // A rolling mean over the last second, so the readout does not flicker on a single long frame.
    const fpsAccum = useRef({ frames: 0, elapsed: 0 });

    // The game is independent of the renderer: it needs neither a canvas nor a clock, so it
    // boots on mount and the frame loop below only ever advances it.
    useEffect(() => {
        const game = new LeafGame({ simRate: SIM_RATE });
        gameRef.current = game;
        return () => {
            game.dispose();
            gameRef.current = null;
            nodeFor.current.clear();
        };
    }, []);

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
        const game = gameRef.current;
        if (game === null) return;

        // 1: advance the sim by real time. The Loop steps whole fixed ticks; leftover time
        //    stays in its accumulator (the panel's heartbeat).
        game.advance(dt);

        // 2: reap entities that crossed the exit, and drop the nodes mirroring them.
        const exited = game.reapPast(exitX(renderer.viewport));
        if (exited.length > 0) {
            const nodes: NodeId[] = [];
            for (const id of exited) {
                const node = nodeFor.current.get(id);
                if (node !== undefined) nodes.push(node);
                nodeFor.current.delete(id);
            }
            renderer.destroyNodes(nodes);
            stats.current.retired += exited.length;
        }

        // 3: mirror every live entity's transform onto its node — one batched call for the
        //    whole population, the single boundary crossing the interface is shaped for (§11.1).
        const views = game.views();
        if (views.length > 0) {
            renderer.updateNodes(
                views.map((view) => ({
                    id: nodeFor.current.get(view.id)!,
                    position: { x: view.x, y: view.y },
                    rotation: view.rotation,
                })),
            );
        }
        stats.current.live = views.length;

        // The HUD publishes on the fps window, NOT every frame. Calling `setHud` per frame would
        // re-render React 60 times a second to change a few digits — the cost this component is
        // structured to avoid. Twice a second is faster than anyone reads a counter.
        const fps = fpsAccum.current;
        fps.frames += 1;
        fps.elapsed += dt;
        if (fps.elapsed >= HUD_INTERVAL) {
            stats.current.fps = Math.round(fps.frames / fps.elapsed);
            fps.frames = 0;
            fps.elapsed = 0;
            // A fresh object, because React compares by identity.
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
            const game = gameRef.current;
            if (renderer === null || game === null) return;

            // The click's world position — `screenToWorld` needs coordinates relative to the
            // CANVAS, so the container's own offset comes off first (§3: screen space is canvas
            // top-left, CSS px).
            const rect = event.currentTarget.getBoundingClientRect();
            const world = renderer.screenToWorld({
                x: event.clientX - rect.left,
                y: event.clientY - rect.top,
            });

            const enterX = spawnX(renderer.viewport);
            // The entity is the source of truth; the node just mirrors it.
            const entityId = game.spawn({
                x: enterX,
                y: world.y,
                speed: DEFAULT_SPEED,
                spin: DEFAULT_SPIN,
            });

            const nodeId = renderer.createNode({
                kind: 'sprite',
                texture: LEAF,
                surface: 'world',
                position: { x: enterX, y: world.y },
                scale: { x: LEAF_SCALE, y: LEAF_SCALE },
                layer: 10,
            });

            // A smaller sprite parented to the leaf: it follows the leaf's POSITION but inherits
            // neither its rotation nor its scale (§5). Only the parent mirrors an entity, so this
            // also gives the inspector a real two-level tree — and makes it obvious that the
            // child's `local` and `resolved` positions differ while its rotation stays 0.
            renderer.createNode({
                kind: 'sprite',
                texture: LEAF,
                surface: 'world',
                parent: nodeId,
                position: { x: 0, y: 34 },
                scale: { x: 1, y: 1 },
                alpha: 0.55,
                layer: 11,
            });

            nodeFor.current.set(entityId, nodeId);
            stats.current.spawned += 1;
            stats.current.live = nodeFor.current.size;
            // Published immediately rather than waiting for the frame-loop window: a click whose
            // counter does not move for half a second reads as a dropped click.
            setHud({ ...stats.current });
        },
        [renderer],
    );

    const clear = useCallback(() => {
        const game = gameRef.current;
        if (renderer === null || game === null) return;
        const ids = game.clear();
        const nodes: NodeId[] = [];
        for (const id of ids) {
            const node = nodeFor.current.get(id);
            if (node !== undefined) nodes.push(node);
        }
        renderer.destroyNodes(nodes);
        nodeFor.current.clear();
        stats.current.retired += ids.length;
        stats.current.live = 0;
        setHud({ ...stats.current });
    }, [renderer]);

    // Read straight off the game ref so the panel's identity is stable and it can poll without
    // re-arming on every render.
    const readLoopStats = useCallback((): LoopStats | null => gameRef.current?.stats() ?? null, []);
    const setPaused = useCallback((paused: boolean) => gameRef.current?.setPaused(paused), []);

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

            <div className="stage__panels">
                <Inspector renderer={renderer} />
                <LoopPanel read={readLoopStats} onSetPaused={setPaused} />
            </div>
        </div>
    );
}
