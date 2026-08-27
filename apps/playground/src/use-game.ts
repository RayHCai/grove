// The React <-> GameClient seam: dial, session, frame loop, teardown.
//
// The client owns the frame — `GameClient.frame()` drains the socket, advances the tick clock,
// flushes input, pushes transforms and calls `render()` — so this hook supplies the loop that
// drives it, and runs the HUD bridge behind it. Everything the panels show is polled off `stats()`,
// because the client publishes no events for it; the HUD is not, because `ClientHUDSink` does.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
    ClientHUDSink,
    ClientStats,
    FrameSource,
    GameClient,
    SessionState,
} from '@platform/client';
import { createPerformanceClock } from '@platform/client/browser';
import { createClient } from '@platform/engine/host';
import type { CameraState, IRenderer } from '@platform/renderer';
import { connectWebSocket } from '@platform/transport/websocket';
import { HudBridge, pressWidget } from './hud';
import { pickLeaf } from './pick';
import { PROJECT } from './project';
import { CLIENT_SCRIPTS } from './scripts';
import { BINDINGS, CODE_CLEAR, SCREEN_LOBBY, WIDGET_READY } from './shared';
import { createStageInputDevice } from './stage-input';

/** Seconds between fps samples, which is also the averaging window. */
const FPS_WINDOW = 0.5;

/** Where this tab's player id is kept, so a reload dials back as the same player. */
const IDENTITY_KEY = 'grove.playerId';

/**
 * Everything the session panel shows: the client's own stats, plus the two counter sets it does not
 * fold in and the frame rate nothing but this hook measures.
 */
export interface GameStats extends ClientStats {
    fps: number;
    /** Wire ops the mirror declined to apply. Nonzero after a clean session is a bug. */
    droppedAttach: number;
    oversizedList: number;
    invalidNetId: number;
    /** Corrections the predicted world could not ease into and had to snap. */
    snappedCorrections: number;
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
    /** The live HUD, or `null` before the session exists. React subscribes to its `onChange`. */
    hud: ClientHUDSink | null;
    /** Polled by the panels; `null` before the session exists. */
    readStats: () => GameStats | null;
    /** Synthesizes the clear key, so the HUD button and the keyboard take the same path. */
    requestClear: () => void;
    /** Presses the ready widget — the interaction frame, not an input action. */
    pressReady: () => void;
}

export function useGame(opts: UseGameOptions): UseGameResult {
    const clientRef = useRef<GameClient | null>(null);
    const emitRef = useRef<((code: string, down: boolean) => void) | null>(null);
    const fpsRef = useRef(0);

    const [state, setState] = useState<SessionState | 'connecting'>('connecting');
    const [failure, setFailure] = useState<string | null>(null);
    const [hud, setHud] = useState<ClientHUDSink | null>(null);

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
        let bridge: HudBridge | null = null;

        const device = createStageInputDevice({
            container,
            renderer,
            // A pointer hit is resolved here and nowhere lower: the entity a click landed on is a
            // claim about this tab's own camera, which no authority can recompute.
            onWorldPress: (x, y) => {
                const mirror = client?.mirror;
                if (mirror === undefined) return;
                const hit = pickLeaf(mirror.runtime, x, y);
                if (hit !== undefined) client?.pointer('onClick', hit);
            },
        });
        // The bridge runs BEHIND the client's own frame: it reads state the drain just applied, so
        // running it first would show every widget one frame stale.
        const frames = createCountingFrameSource(fpsRef, () => bridge?.sync());

        emitRef.current = (code: string, down: boolean) => device.emit({ kind: 'key', code, down });

        void (async () => {
            try {
                const transport = await connectWebSocket(withPlayer(url, tabIdentity()));
                if (cancelled) {
                    transport.close();
                    return;
                }

                // The composition root, not `new GameClient`: the identity this tab claims is
                // derived from the SAME manifest the authority booted from, so a stale tab across a
                // `dev` restart is refused at the handshake rather than drawn wrongly.
                client = createClient({
                    transport,
                    renderer,
                    frames,
                    device,
                    clock: createPerformanceClock(),
                    name: tabIdentity(),
                    bindings: BINDINGS,
                    camera: () => cameraRef.current(),
                    predict: true,
                    scripts: CLIENT_SCRIPTS,
                    project: PROJECT,
                });

                clientRef.current = client;
                bridge = new HudBridge({ client, renderer });
                setHud(client.hud);

                const unsubscribe = client.lifecycle.onChange((next: SessionState) => {
                    setState(next);
                    setFailure(describeFailure(client));
                });
                client.start();
                setState(client.state);

                // Unmounted while the socket was still connecting: cleanup already ran and held
                // neither of these, so the teardown it could not do happens here.
                if (cancelled) {
                    unsubscribe();
                    bridge.dispose();
                    bridge = null;
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
            setHud(null);
            // Before the client's own teardown, because both reach the renderer and only this one
            // knows which node is the clock's.
            bridge?.dispose();
            bridge = null;
            // `ownsRenderer` is left false: `useRenderer` built the renderer and destroys it.
            if (client !== null) client.destroy();
            else device.dispose();
        };
    }, [renderer, url, containerRef]);

    const readStats = useCallback((): GameStats | null => {
        const live = clientRef.current;
        if (live === null) return null;
        const mirror = live.mirror?.counters;
        const predicted = live.prediction?.counters;
        return {
            ...live.stats(),
            fps: fpsRef.current,
            droppedAttach: mirror?.droppedAttach ?? 0,
            oversizedList: mirror?.oversizedList ?? 0,
            invalidNetId: mirror?.invalidNetId ?? 0,
            snappedCorrections: predicted?.snappedCorrections ?? 0,
        };
    }, []);

    const requestClear = useCallback(() => {
        const emit = emitRef.current;
        if (emit === null) return;
        emit(CODE_CLEAR, true);
        emit(CODE_CLEAR, false);
    }, []);

    /**
     * The one client→server command that is not an input action.
     *
     * The screen name scopes the press, so `LobbyScreen`'s own handler answers it locally on this
     * frame while the authority is told on the next — which is why the button can say "asked"
     * before anything has granted it.
     */
    const pressReady = useCallback(() => {
        const live = clientRef.current;
        if (live !== null) pressWidget(live, WIDGET_READY, SCREEN_LOBBY);
    }, []);

    return { state, failure, hud, readStats, requestClear, pressReady };
}

/**
 * A rAF frame source that also keeps a rolling fps and runs the host's own after-frame work.
 *
 * The client stops it on close, reject and failure, so the loop's lifetime is the session's rather
 * than the component's.
 */
function createCountingFrameSource(fps: React.RefObject<number>, after: () => void): FrameSource {
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
                after();
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

/**
 * A per-tab id that survives a reload, so this tab rejoins as the player it saved.
 *
 * `sessionStorage` and not `localStorage`, which every tab shares — but note it is COPIED into a
 * duplicated tab and into one opened from a link, and the server refuses the second claim.
 */
function tabIdentity(): string {
    const held = sessionStorage.getItem(IDENTITY_KEY);
    if (held !== null) return held;
    // Not `randomUUID`, which is secure-context only: this page is served over plain http, so on
    // any origin but loopback it is undefined and the whole session would fail to construct.
    const [n] = crypto.getRandomValues(new Uint16Array(1));
    const minted = `tab-${(n ?? 0).toString(16).padStart(4, '0')}`;
    sessionStorage.setItem(IDENTITY_KEY, minted);
    return minted;
}

/** The peer's own claim, which only a toy host would take — this one says so where it reads it. */
function withPlayer(url: string, identity: string): string {
    const parsed = new URL(url);
    parsed.searchParams.set('player', identity);
    return parsed.toString();
}
