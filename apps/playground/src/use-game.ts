// The React <-> GameClient seam: dial, session, frame loop, teardown.
//
// The client owns the frame — `GameClient.frame()` drains the socket, advances the tick clock,
// flushes input, pushes transforms and calls `render()` — so this hook supplies the loop that
// drives it and nothing else. Everything the UI shows is polled off `stats()`, because the client
// publishes no events for it.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientStats, FrameSource, SessionState } from '@platform/client';
import { GameClient } from '@platform/client';
import { createPerformanceClock } from '@platform/client/browser';
import type { CameraState, IRenderer } from '@platform/renderer';
import { connectWebSocket } from '@platform/transport/websocket';
import { BINDINGS, CODE_CLEAR, PROJECT_HASH, PROJECT_ID } from './shared';
import { createStageInputDevice } from './stage-input';
import { CLIENT_SCRIPTS } from './scripts';

/**
 * What this tab claims to be running.
 *
 * `bundleHash` stays empty and no `bundle` loader is passed: `Runner` is compiled into the page's own
 * bundle, so there is nothing to fetch — the server declares none either, and the two agree.
 */
const PROJECT = { projectId: PROJECT_ID, projectHash: PROJECT_HASH, bundleHash: '' };

/** Seconds between fps samples, which is also the averaging window. */
const FPS_WINDOW = 0.5;

export interface GameStats extends ClientStats {
    fps: number;
}

export interface UseGameOptions {
    /** `null` until the renderer is initialized; the client must never see an uninitialized one. */
    renderer: IRenderer | null;
    container: React.RefObject<HTMLDivElement | null>;
    url: string;
    /** Resolves the camera each frame. Must be stable and read a ref, not React state. */
    camera: () => CameraState;
}

export interface UseGameResult {
    state: SessionState | 'connecting';
    failure: string | null;
    /** This tab's player slot, which picks the tint its leaves spawn under. `null` until live. */
    playerIndex: number | null;
    /** Polled by the panels; `null` before the session exists. */
    readStats: () => GameStats | null;
    /** Synthesizes the clear key, so the HUD button and the keyboard take the same path. */
    requestClear: () => void;
}

export function useGame(opts: UseGameOptions): UseGameResult {
    const clientRef = useRef<GameClient | null>(null);
    const emitRef = useRef<((code: string, down: boolean) => void) | null>(null);
    const fpsRef = useRef(0);

    const [state, setState] = useState<SessionState | 'connecting'>('connecting');
    const [failure, setFailure] = useState<string | null>(null);
    const [playerIndex, setPlayerIndex] = useState<number | null>(null);

    // The camera resolver is captured once by `GameClient`, so it is read through a ref — a fresh
    // closure per render would be ignored, and re-creating the client would resync the world.
    const cameraRef = useRef(opts.camera);
    cameraRef.current = opts.camera;

    const { renderer, url } = opts;
    const containerRef = opts.container;

    useEffect(() => {
        const container = containerRef.current;
        if (renderer === null || container === null) return;

        // StrictMode dials twice; without this the orphan socket becomes a second player that
        // never goes away.
        let cancelled = false;
        let client: GameClient | null = null;

        const device = createStageInputDevice({ container, renderer });
        const frames = createCountingFrameSource(fpsRef);

        emitRef.current = (code: string, down: boolean) => device.emit({ kind: 'key', code, down });

        void (async () => {
            try {
                const transport = await connectWebSocket(url);
                if (cancelled) {
                    transport.close();
                    return;
                }

                client = new GameClient({
                    transport,
                    renderer,
                    frames,
                    device,
                    clock: createPerformanceClock(),
                    name: tabName(),
                    bindings: BINDINGS,
                    camera: () => cameraRef.current(),
                    predict: true,
                    scripts: CLIENT_SCRIPTS,
                    project: PROJECT,
                });

                clientRef.current = client;
                const unsubscribe = client.lifecycle.onChange((next: SessionState) => {
                    setState(next);
                    setFailure(describeFailure(client));
                    // The roster lands with the welcome, so the slot is only readable once live.
                    setPlayerIndex(client?.localPlayer?.index ?? null);
                });
                client.start();
                setState(client.state);

                if (cancelled) {
                    unsubscribe();
                    client.destroy();
                }
            } catch (cause) {
                if (cancelled) return;
                setState('failed');
                setFailure(cause instanceof Error ? cause.message : String(cause));
            }
        })();

        return () => {
            cancelled = true;
            emitRef.current = null;
            clientRef.current = null;
            // `ownsRenderer` is left false: `useRenderer` built the renderer and destroys it.
            if (client !== null) client.destroy();
            else device.dispose();
        };
    }, [renderer, url, containerRef]);

    const readStats = useCallback((): GameStats | null => {
        const live = clientRef.current;
        if (live === null) return null;
        return { ...live.stats(), fps: fpsRef.current };
    }, []);

    const requestClear = useCallback(() => {
        const emit = emitRef.current;
        if (emit === null) return;
        emit(CODE_CLEAR, true);
        emit(CODE_CLEAR, false);
    }, []);

    return { state, failure, playerIndex, readStats, requestClear };
}

/**
 * A rAF frame source that also keeps a rolling fps.
 *
 * The client stops it on close, reject and failure, so the loop's lifetime is the session's rather
 * than the component's.
 */
function createCountingFrameSource(fps: React.RefObject<number>): FrameSource {
    let handle = 0;
    let frames = 0;
    let windowStart = 0;

    return {
        start(onFrame: (nowSeconds: number) => void): void {
            if (handle !== 0) return;
            const loop = (nowMs: number): void => {
                handle = requestAnimationFrame(loop);
                const now = nowMs / 1000;
                if (windowStart === 0) windowStart = now;
                frames += 1;
                const elapsed = now - windowStart;
                if (elapsed >= FPS_WINDOW) {
                    fps.current = Math.round(frames / elapsed);
                    frames = 0;
                    windowStart = now;
                }
                onFrame(now);
            };
            handle = requestAnimationFrame(loop);
        },
        stop(): void {
            if (handle === 0) return;
            cancelAnimationFrame(handle);
            handle = 0;
        },
    };
}

function describeFailure(client: GameClient | null): string | null {
    const reason = client?.lifecycle.failure;
    if (reason === undefined) return null;
    switch (reason.kind) {
        case 'rejected':
            return reason.reason;
        case 'undecodable':
            return 'the server sent a welcome this client cannot read';
        case 'internal':
            return `client defect: ${reason.message}`;
        case 'peer':
            return `bad frame from the server: ${reason.message}`;
        case 'bundle':
            return reason.message;
    }
}

/** A per-tab display name, so several tabs are told apart in the roster. */
function tabName(): string {
    // Not `randomUUID`, which is secure-context only: this page is served over plain http, so on
    // any origin but loopback it is undefined and the whole session would fail to construct.
    const [n] = crypto.getRandomValues(new Uint16Array(1));
    return `tab-${(n ?? 0).toString(16).padStart(4, '0')}`;
}
