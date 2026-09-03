// The React <-> session seam: what is left of it once `@platform/glue/client` owns the composition.
//
// Dialling, wiring the state listener before the join, abandoning a dial this component no longer
// wants, and tearing down in an order that leaves nothing behind are all `connectTo`'s. What is
// genuinely React's stays here: an `AbortController` per effect, the frame loop this app measures
// its own fps on, and the three values the chrome renders from.
//
// The client owns the frame — `GameClient.frame()` drains the socket, advances the tick clock,
// flushes input, pushes transforms and calls `render()` — so this hook supplies the loop that
// drives it, and runs the HUD bridge behind it. Everything the panels show is polled off `stats()`,
// because the client publishes no events for it; the HUD is not, because `ClientHUDSink` does.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPerformanceClock } from '@platform/client/browser';
import { connectTo } from '@platform/glue/client';
import type {
    ClientHUDSink,
    ClientInstance,
    ClientStats,
    FailureReason,
    FrameSource,
    SessionState,
} from '@platform/glue/client';
import type { CameraState, IRenderer } from '@platform/renderer';
import { ClockNode, openHud, pressWidget } from './hud';
import { PROJECT } from './project';
import { CLIENT_SCRIPTS } from './client-registry';
import { BINDINGS, CODE_CLEAR, SCREEN_LOBBY, WIDGET_READY } from './scripts/globals';
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
    /** `null` until the renderer is initialized; the session must never see an uninitialized one. */
    renderer: IRenderer | null;
    container: React.RefObject<HTMLDivElement | null>;
    url: string;
    /** Resolves the camera each frame. Must be stable and read a ref, not React state. */
    camera: () => CameraState;
}

export interface UseGameResult {
    state: SessionState;
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
    const sessionRef = useRef<ClientInstance | null>(null);
    const emitRef = useRef<((code: string, down: boolean) => void) | null>(null);
    const fpsRef = useRef(0);

    const [state, setState] = useState<SessionState>('connecting');
    const [failure, setFailure] = useState<string | null>(null);
    const [hud, setHud] = useState<ClientHUDSink | null>(null);

    // The camera resolver is captured once by the session, so it is read through a ref — a fresh
    // closure per render would be ignored, and re-creating the session would resync the world.
    const cameraRef = useRef(opts.camera);
    cameraRef.current = opts.camera;

    const { renderer, url } = opts;
    const containerRef = opts.container;

    useEffect(() => {
        const container = containerRef.current;
        if (renderer === null || container === null) return;

        // StrictMode mounts twice, and a dial resolves on its own schedule. The signal is what
        // `connectTo` abandons an unwanted dial by — and what closes a session that was built
        // between this effect being torn down and its own continuation running.
        const abort = new AbortController();
        let session: ClientInstance | null = null;
        let clock: ClockNode | null = null;

        const device = createStageInputDevice({
            container,
            renderer,
            // The entity a click landed on is a claim about this tab's own camera, which no
            // authority can recompute — but the client resolves it, because only the client holds
            // both the node map and the interpolation delay the drawn pose carries.
            onScreenPress: (x, y) => {
                const hit = session?.client.entityAt({ x, y });
                if (hit !== undefined) session?.client.pointer('onClick', hit);
            },
        });
        // The clock node runs BEHIND the client's own frame: it reads state the drain just applied,
        // so running it first would show a value one frame stale.
        const frames = createCountingFrameSource(fpsRef, () => {
            if (session !== null) clock?.sync(session.client);
        });

        emitRef.current = (code: string, down: boolean) => device.emit({ kind: 'key', code, down });

        void (async () => {
            try {
                session = await connectTo({
                    url: withPlayer(url, tabIdentity()),
                    signal: abort.signal,
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
                    // Taken as an option rather than subscribed afterwards: `connectTo` joins
                    // before it returns, so a listener attached to what it hands back would have
                    // already missed a session that settled on its first frame.
                    onState: (next, reason) => {
                        setState(next);
                        setFailure(describeFailure(reason));
                        // The mirror exists from the welcome onward, and the screens are registered
                        // against it — a resync builds a new one, so this runs again for that too.
                        if (next === 'live' && session !== null) openHud(session.client);
                    },
                });

                sessionRef.current = session;
                clock = new ClockNode(renderer);
                setHud(session.hud);
                setState(session.state);
            } catch (cause) {
                // An abandoned dial is this component going away, not a failure to show anyone.
                if (abort.signal.aborted) return;
                setState('failed');
                setFailure(cause instanceof Error ? cause.message : String(cause));
            }
        })();

        return () => {
            // Abandons a dial still in flight, and closes a session that resolved into this
            // teardown. What is left below is only what this app owns.
            abort.abort();
            emitRef.current = null;
            sessionRef.current = null;
            setHud(null);
            // Before the session's own teardown, because both reach the renderer and only this one
            // knows which node is the clock's.
            clock?.dispose();
            clock = null;
            // `close()` is idempotent, so the abort above having already run it is no different.
            // With no session there is no one to dispose the device this effect built.
            if (session !== null) session.close();
            else device.dispose();
        };
    }, [renderer, url, containerRef]);

    const readStats = useCallback((): GameStats | null => {
        const live = sessionRef.current;
        if (live === null) return null;
        const mirror = live.client.mirror?.counters;
        const predicted = live.client.prediction?.counters;
        return {
            ...live.client.stats(),
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
        const live = sessionRef.current;
        if (live !== null) pressWidget(live.client, WIDGET_READY, SCREEN_LOBBY);
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

function describeFailure(reason: FailureReason | undefined): string | null {
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
