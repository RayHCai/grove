import { useEffect, useRef, useState } from 'react';
import {
    createBrowserBundleSource,
    createCanvasInputDevice,
    createPerformanceClock,
    createRafFrameSource,
} from '@platform/client/browser';
import { ClientInstance, connectTo } from '@platform/glue/client';
import type { Binding, FailureReason, SessionState, Transport } from '@platform/glue/client';
import type { ScriptId } from '@platform/project';
import { createPixiRenderer } from '@platform/renderer/pixi';
import type { IRenderer } from '@platform/renderer';
import type { ScriptRegistry } from '@platform/scripting';

/**
 * Why a join did not happen. Wider than the wire's `RejectReason`: a ticket is checked before the
 * upgrade, so its refusal is an HTTP status that never becomes a reject envelope, and a socket that
 * never opened produces no envelope at all.
 */
export type RefusalReason = 'version' | 'full' | 'identity' | 'ticket' | 'bundle' | 'unreachable';

/** What this client claims to be running, which the authority compares before it admits anyone. */
export interface GameProject {
    projectId: string;
    projectHash: string;
}

/** One end of a pair whose other end a world in this same page already holds. */
export interface LocalLink {
    transport: Transport;
    /**
     * Moves frames across the pair at the top of every frame.
     *
     * A real socket delivers on its own; a pair only moves when somebody turns it, and a session
     * that never pumped would send a join nothing ever reads.
     */
    pump: () => void;
    /** Ends the authority's half. The world is this page's, so its teardown is too. */
    close?: () => void;
}

/**
 * Where the other end of a session is.
 *
 * The one thing that differs between playing a deployed game and previewing the one in an editor,
 * and the reason it is a union rather than two components: everything below it — the renderer, the
 * frame loop, the device, the handshake, the refusals — is the same session either way, and a
 * preview that composed its own would be a preview of something else.
 */
export type GameAuthority =
    /** A deployed world, over a real socket, admitted with the ticket the allocator signed. */
    | { kind: 'remote'; serverUrl: string; ticket: string }
    /**
     * A world in this page. The caller has already booted it and answers with the session's half
     * of the pair; the classes are here too, so nothing is fetched.
     */
    | { kind: 'local'; open: () => LocalLink; scripts: ScriptRegistry<ScriptId> };

export interface GamePlayerProps {
    /** Where the other end is: a deployed box, or a world this page is holding. */
    authority: GameAuthority;
    /**
     * The identity the authority compares before it allocates a `Player`.
     *
     * Required, not optional: only `bundleHash` has an empty-string escape at the handshake, so a
     * session that declared nothing here would be refused by every world that declares a project.
     */
    project: GameProject;
    /** The name other peers see. */
    name: string;
    /**
     * The reference stage the game's interface was authored against, in world px.
     *
     * A prop rather than a constant: it is a project setting, and a stage sized to something the
     * creator did not author against puts every widget in the wrong place. The renderer is built
     * before the session, so it cannot be read off the `Welcome` that carries the world's bounds.
     */
    design: { width: number; height: number };
    /**
     * The ground the world is drawn on, as `0xRRGGBB` or `'transparent'`.
     *
     * Defaults to white rather than the renderer's own black: a game with no art yet draws nothing,
     * and a creator pressing Play should be able to tell an empty stage from a stage that never
     * came up. It is a prop because it wants to be a project setting one day, and the renderer is
     * built before the session — so, like `design`, it cannot be read off the `Welcome`.
     */
    background?: number | 'transparent';
    onReady?: () => void;
    onRefused?: (reason: RefusalReason, message: string) => void;
    /** How the renderer is built; a test hands in one that needs no GPU. */
    createRenderer?: () => IRenderer;
    /** How a remote session is dialled; a test hands in one that needs no socket. */
    connect?: typeof connectTo;
}

/**
 * WASD and the arrow keys, onto the two axes `BaseMovement` reads.
 *
 * `moveX`/`moveY` are the engine's fixed, panel-mapped move axes — not something a creator's script
 * binds — so this is the one control scheme every game with a movement class gets, the same way a
 * deployed session and a preview both get a renderer and a frame loop without asking for either.
 */
const DEFAULT_MOVE_BINDINGS: readonly Binding[] = [
    { kind: 'axis', code: 'keys:KeyA', action: 'moveX', polarity: -1 },
    { kind: 'axis', code: 'keys:KeyD', action: 'moveX', polarity: 1 },
    { kind: 'axis', code: 'keys:ArrowLeft', action: 'moveX', polarity: -1 },
    { kind: 'axis', code: 'keys:ArrowRight', action: 'moveX', polarity: 1 },
    // World y points up, so the key that reads "forward" is the one that increases it.
    { kind: 'axis', code: 'keys:KeyW', action: 'moveY', polarity: 1 },
    { kind: 'axis', code: 'keys:KeyS', action: 'moveY', polarity: -1 },
    { kind: 'axis', code: 'keys:ArrowUp', action: 'moveY', polarity: 1 },
    { kind: 'axis', code: 'keys:ArrowDown', action: 'moveY', polarity: -1 },
];

/** The stage's ground until a project declares one of its own. */
const WHITE = 0xffffff;

/** The subprotocol a ticket rides, since a browser cannot set a header on `new WebSocket(url)`. */
export function ticketProtocol(ticket: string): string {
    return `grove.ticket.${ticket}`;
}

/**
 * The canvas a game session mounts onto.
 *
 * It holds no authority and checks nothing about the world: admission, request checking and ticket
 * verification are all the authority's, wherever that authority is. What it owns is the three
 * things a session cannot compose for itself in a browser — a renderer over a real canvas, the
 * frame loop that drives it, and the device that turns pointer and key events into input.
 *
 * Against a deployed world the creator's code is **not** fetched here: the authority names it in
 * the `Welcome`, and the session fetches, bounds, hashes and verifies it before evaluating a byte.
 * Against a local one there is nothing to fetch, because the classes are already in this page —
 * which is the whole of what a preview does differently.
 */
export function GamePlayer({
    authority,
    project,
    name,
    design,
    background = WHITE,
    onReady,
    onRefused,
    createRenderer = createPixiRenderer,
    connect = connectTo,
}: GamePlayerProps): React.JSX.Element {
    const stage = useRef<HTMLDivElement>(null);
    const [state, setState] = useState<SessionState>('connecting');

    // Read through refs so a parent may pass fresh closures every render without tearing the GPU
    // context down and resyncing the world.
    const readyRef = useRef(onReady);
    readyRef.current = onReady;
    const refusedRef = useRef(onRefused);
    refusedRef.current = onRefused;

    useEffect(() => {
        const container = stage.current;
        if (container === null) return;

        // StrictMode mounts twice and both a renderer init and a dial resolve on their own
        // schedule, so every await below is guarded by this and a session built into a teardown is
        // closed through the signal rather than by a flag the dial cannot see.
        const abort = new AbortController();
        const renderer: IRenderer = createRenderer();
        let session: ClientInstance | null = null;
        let link: LocalLink | undefined;
        // Whether `init()` has settled. Destroying before it has no-ops and init then appends its
        // canvas anyway, leaking a live WebGL context — which StrictMode hits every mount.
        let initialized = false;

        const onState = (next: SessionState, failure: FailureReason | undefined): void => {
            setState(next);
            if (next === 'live') readyRef.current?.();
            if (next === 'failed') {
                const [reason, message] = describe(failure);
                refusedRef.current?.(reason, message);
            }
        };

        void (async () => {
            try {
                await renderer.init({ container, design, background });
                initialized = true;
                if (abort.signal.aborted) {
                    renderer.destroy();
                    return;
                }

                const seams = {
                    renderer,
                    frames: createRafFrameSource(),
                    device: createCanvasInputDevice({ container, renderer }),
                    clock: createPerformanceClock(),
                    bindings: DEFAULT_MOVE_BINDINGS,
                    project,
                    name,
                    // Taken as an option rather than subscribed afterwards: a session joins as it
                    // is started, so a listener attached to what that hands back would already
                    // have missed one that settled on its first frame.
                    onState,
                };

                if (authority.kind === 'local') {
                    link = authority.open();
                    // Built and started here rather than dialled: there is no socket to open, and
                    // the pair only moves when `pump` turns it.
                    session = new ClientInstance({
                        ...seams,
                        transport: link.transport,
                        pump: link.pump,
                        // Passed in, because no `Welcome` will name code to fetch: a world in this
                        // page declares no bundle, and the classes are already loaded.
                        scripts: authority.scripts,
                    }).start();
                    return;
                }

                session = await connect({
                    ...seams,
                    url: authority.serverUrl,
                    signal: abort.signal,
                    // The ticket rides the subprotocol rather than the url: a url reaches access
                    // logs, proxy traces and `Referer`, and a subprotocol reaches none of them.
                    protocols: [ticketProtocol(authority.ticket)],
                    // What the session fetches the creator's code with, once the welcome names it.
                    bundle: createBrowserBundleSource(),
                });
            } catch (cause) {
                // An abandoned dial is this component going away, not a failure to show anyone.
                if (abort.signal.aborted) return;
                setState('failed');
                refusedRef.current?.(
                    'unreachable',
                    cause instanceof Error ? cause.message : String(cause),
                );
            }
        })();

        return () => {
            // Abandons a dial still in flight and closes a session that resolved into this
            // teardown; `close()` is idempotent, so both running is no different from one.
            abort.abort();
            session?.close();
            // After the session, so the authority outlives the peer that is leaving it.
            link?.close?.();
            if (initialized) renderer.destroy();
        };
    }, [authority, project, name, design, background, createRenderer, connect]);

    return <div ref={stage} className="grove-stage" data-state={state} />;
}

/** The failure as a person can act on it: what went wrong, and a line that says so. */
function describe(failure: FailureReason | undefined): [RefusalReason, string] {
    if (failure === undefined) return ['unreachable', 'the session ended'];
    switch (failure.kind) {
        case 'rejected':
            // The wire's reason is a bare string, so a token this build has no wording for is
            // shown as a refusal rather than mapped to whichever case happened to be last.
            return REJECTIONS.has(failure.reason)
                ? [failure.reason as RefusalReason, refusalText(failure.reason)]
                : ['unreachable', 'this game turned the join away'];
        case 'bundle':
            return ['bundle', failure.message];
        case 'undecodable':
            return ['unreachable', 'this game sent a welcome the player could not read'];
        case 'peer':
            return ['unreachable', 'this game sent something the player could not read'];
        case 'internal':
            return ['unreachable', `the player hit a defect: ${failure.message}`];
    }
}

/** Every rejection the wire names. `RejectReason` is deliberately coarse, and so is this. */
const REJECTIONS: ReadonlySet<string> = new Set(['version', 'full', 'identity']);

function refusalText(reason: string): string {
    switch (reason) {
        case 'version':
            return 'this game is running a different version than the player loaded';
        case 'full':
            return 'this game is full';
        default:
            return 'somebody is already playing as you';
    }
}
