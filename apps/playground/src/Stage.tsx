// The canvas pane: one connection to the authority, and the chrome around it.
//
// NOTHING HERE SIMULATES ANYTHING. A click becomes an input frame; the server decides whether a
// leaf exists and where it is; the reply becomes renderer nodes through the client's own bridge.
// This component owns no entities, no node ids and no clock — which is the whole difference from
// a single-player harness, and why the click handler is a binding rather than a spawn call.

import { useCallback, useMemo, useRef, useState } from 'react';
import type { CameraState, IRenderer } from '@platform/renderer';
import { useRenderer } from './use-renderer';
import { useGame } from './use-game';
import { Inspector } from './Inspector';
import { NetPanel } from './NetPanel';
import {
    DESIGN,
    LEAF_ASSET,
    LEAF_URL,
    MARKER_ASSET,
    MARKER_URL,
    defaultGameUrl,
    tintCss,
} from './shared';

/**
 * Zoom levels the UI offers.
 *
 * Zooming in shrinks the world viewport, which is what makes culling observable: a leaf still
 * travelling between the old edges is now outside the new ones, so the inspector's `cull` flag
 * lights up. At zoom 1 nothing culls — the server's stage is the design stage, so a leaf is only
 * ever just outside it.
 */
const ZOOMS = [1, 2, 4] as const;

export function Stage(): React.JSX.Element {
    // Camera state lives in a ref as well as in React state: the resolver below is captured once by
    // the client and read every frame, so it must not close over a stale render's value.
    const zoomRef = useRef(1);
    const [zoom, setZoom] = useState(1);

    const changeZoom = useCallback((next: number) => {
        zoomRef.current = next;
        setZoom(next);
    }, []);

    // The textures must be resident BEFORE the first welcome. The client's bridge starts its own
    // manifest load without awaiting it and reconciles the join snapshot on the next statement, and
    // a sprite whose texture arrives after its node was created is never repointed — so every leaf
    // already in the world at join would draw the placeholder for the rest of the session.
    const onReady = useCallback(async (renderer: IRenderer) => {
        const result = await renderer.loadAssets([
            { name: LEAF_ASSET, kind: 'image', url: LEAF_URL, filter: 'nearest' },
            { name: MARKER_ASSET, kind: 'image', url: MARKER_URL, filter: 'nearest' },
        ]);
        // `loadAssets` resolves with failures rather than rejecting, so one 404 must be surfaced
        // deliberately or it shows up as a silent magenta placeholder.
        if (result.failed.length > 0) {
            const [failure] = result.failed;
            throw new Error(`could not load '${failure?.name}': ${failure?.reason}`);
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
    });

    // The only supported camera control point: the client pushes the camera every frame regardless
    // of what the app set, so a `setCamera` from a change handler would be reverted immediately.
    const camera = useCallback(
        (): CameraState => ({ position: { x: 0, y: 0, z: 0 }, zoom: zoomRef.current }),
        [],
    );

    const url = useMemo(
        () => import.meta.env.VITE_GAME_URL ?? defaultGameUrl(window.location.hostname),
        [],
    );

    const { state, failure, playerIndex, readStats, requestClear } = useGame({
        renderer,
        container: containerRef,
        url,
        camera,
    });

    return (
        <div className="stage">
            <div className="stage__canvas" ref={containerRef} role="presentation" />

            <div className="stage__hud">
                <span className={`badge badge--${phase}`}>{phase}</span>
                <span className={`badge badge--${state}`}>{state}</span>

                {/* Which leaves on the stage are this tab's. The tint rides the template the server
                    spawns under, so the swatch and the sprite read the same number. */}
                {playerIndex !== null && (
                    <span className="stage__me">
                        <i
                            className="stage__swatch"
                            style={{ background: tintCss(playerIndex) }}
                            aria-hidden="true"
                        />
                        yours
                    </span>
                )}

                <span className="stage__url">{url}</span>

                <label className="stage__zoom">
                    zoom
                    <select
                        aria-label="camera zoom"
                        value={zoom}
                        onChange={(e) => changeZoom(Number(e.target.value))}
                        disabled={renderer === null}
                    >
                        {ZOOMS.map((z) => (
                            <option key={z} value={z}>
                                {z}x
                            </option>
                        ))}
                    </select>
                </label>

                {/* Clearing is a server action like any other, so the button takes the same path a
                    keypress does rather than reaching into the world. It clears it for everyone. */}
                <button type="button" onClick={requestClear} disabled={state !== 'live'}>
                    clear (C)
                </button>
            </div>

            {phase === 'failed' && <p className="stage__error">{error?.message}</p>}
            {failure !== null && <p className="stage__error">{failure}</p>}

            <div className="stage__panels">
                <Inspector renderer={renderer} />
                <NetPanel read={readStats} state={state} />
            </div>
        </div>
    );
}
