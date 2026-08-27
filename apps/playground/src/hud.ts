// The bridge from replicated state to the HUD seam.
//
// There is no HUD envelope on the wire, and there cannot be: a HUD is one client's, so `hud.*`
// writes into whichever runtime is current and pushes what changed at that runtime's `HUDSink`. The
// authority's HUD state therefore reaches nobody. What crosses is the `@serverState` the match rules
// write, and this file is the client-side half that turns it back into widgets.
//
// It runs from the host's own frame callback rather than from a script, because a `ClientScript`'s
// `@onUpdate` is dispatched by neither tick pass — the client's update pass and core's both narrow
// to server-located handlers, so the only client code a frame runs is the code the host calls.

import type { GameClient } from '@platform/client';
import type { Leaderboard, Player, Runtime, Scoreboard } from '@platform/core';
import { GAME_KEY, hud, playerKey, withRuntime } from '@platform/core';
import type { IRenderer, NodeId } from '@platform/renderer';
// The LOWERED copy: `LobbyScreen` carries decorators, and Vite's transform would hand them to the
// browser verbatim. `tsc -p tsconfig.server.json` emits this, which is why `dev` runs it first.
import { LobbyScreen } from '../dist/screens/lobby.js';
import type { MatchPhase } from './shared';
import {
    BOARD_SIZE,
    ROUND_SECONDS,
    SCREEN_LOBBY,
    SCREEN_RESULTS,
    STATE_BEST,
    STATE_LIFETIME,
    STATE_PHASE,
    STATE_PLAYER_COUNT,
    STATE_READY,
    STATE_READY_COUNT,
    STATE_ROUND,
    STATE_SECONDS_LEFT,
    STATE_SLOT,
    STATE_WASTED,
    STATE_WINNER,
    WIDGET_BEST,
    WIDGET_CLOCK,
    WIDGET_LIFETIME,
    WIDGET_PHASE,
    WIDGET_READY,
    WIDGET_SCORE,
    WIDGET_SLOT,
    WIDGET_WASTED,
    WIDGET_WINNER,
    rankWidget,
} from './shared';

/** The fields the game host keeps its two wrappers under, as the rules declare them. */
const FIELD_SCORES = 'scores';
const FIELD_BOARD = 'board';

/** Where the in-canvas clock sits on the UI surface, and how it is drawn. */
const CLOCK_OFFSET_Y = 24;
const CLOCK_STYLE = {
    size: 30,
    color: 0xf2f7f3,
    weight: 'bold' as const,
    align: 'center' as const,
};

/** What one sync read off the mirror — kept so the next one writes only what moved. */
interface MatchState {
    phase: MatchPhase;
    secondsLeft: number;
    readyCount: number;
    playerCount: number;
    winnerName: string;
    wasted: number;
    round: number;
    score: number;
    lifetime: number;
    best: number;
    ready: boolean;
    /** The palette seat the rules assigned — never `player.index`, which is never reused. */
    slot: number;
    ranks: string[];
}

function emptyState(): MatchState {
    return {
        phase: 'lobby',
        secondsLeft: 0,
        readyCount: 0,
        playerCount: 0,
        winnerName: '',
        wasted: 0,
        round: 0,
        score: 0,
        lifetime: 0,
        best: 0,
        ready: false,
        slot: 0,
        ranks: [],
    };
}

/** Reads one replicated field off a host record, which is where the hoist put it. */
function field<T>(rt: Runtime, hostKey: string, name: string): T | undefined {
    return rt.hosts.get(hostKey)?.record.values.get(name) as T | undefined;
}

/**
 * Presses a widget with this client's own runtime made current.
 *
 * `pressWidget` dispatches the screen's handler in place but establishes no ambient runtime, and
 * `hud.*` resolves one — so a screen script writing a widget would land in whichever runtime
 * `loadGame` ran last. One client per page makes that the right one by luck; a process holding a
 * server and two clients makes it the wrong one, which is where this was found.
 */
export function pressWidget(client: GameClient, widget: string, screen?: string): void {
    const rt = client.mirror?.runtime;
    if (rt === undefined) return;
    withRuntime(rt, () => client.pressWidget(widget, screen));
}

/**
 * Turns replicated match state into HUD widgets, and keeps the in-canvas clock in step.
 *
 * Every write is diffed first. `hud.*` notifies the sink on every call and the sink notifies React,
 * so writing the same number sixty times a second would re-render the interface at the frame rate
 * to say nothing had changed.
 */
export class HudBridge {
    readonly #client: GameClient;
    readonly #renderer: IRenderer;
    #last: MatchState = emptyState();
    /** The mirror runtime the screens were registered against; a resync builds a new one. */
    #wiredTo: Runtime | undefined;
    /** The screen currently open, so a phase change closes exactly what it opened. */
    #shown: string | null = null;
    #clockNode: NodeId | undefined;

    constructor(opts: { client: GameClient; renderer: IRenderer }) {
        this.#client = opts.client;
        this.#renderer = opts.renderer;
    }

    /** Called once per frame, after the client has drained the socket and advanced its clock. */
    sync(): void {
        const mirror = this.#client.mirror;
        if (mirror === undefined) {
            // A resync discards the runtime the screens were wired into, and the client has already
            // cleared the sink — so the next sync holding a mirror starts fresh on both sides.
            this.#wiredTo = undefined;
            this.#shown = null;
            return;
        }
        const rt = mirror.runtime;
        withRuntime(rt, () => {
            // A fresh mirror has an empty HUD, so the first pass over one writes every widget
            // rather than only what moved — the diff below has nothing true to compare against.
            const fresh = this.#wiredTo !== rt;
            if (fresh) {
                this.#wire();
                this.#wiredTo = rt;
                this.#shown = null;
                this.#last = emptyState();
            }
            this.#write(this.#read(rt), fresh);
        });
    }

    /** Destroys the one node this owns. The client's own bridge destroys only what it created. */
    dispose(): void {
        const node = this.#clockNode;
        if (node === undefined) return;
        this.#clockNode = undefined;
        if (this.#renderer.isAlive(node)) this.#renderer.destroyNode(node);
    }

    /**
     * Registers the screens' scripts, which has to happen before the open that wires them.
     *
     * A screen is minted on first mention and `hud.screen` answers null until then, so minting one
     * with an open-and-close pair is the only way to reach it ahead of the first real open. Both
     * verbs are idempotent and the pair leaves nothing on screen.
     */
    #wire(): void {
        for (const name of [SCREEN_LOBBY, SCREEN_RESULTS]) {
            hud.open(name);
            hud.close(name);
        }
        hud.screen(SCREEN_LOBBY)?.addScript(LobbyScreen);
    }

    #read(rt: Runtime): MatchState {
        const me = this.#client.localPlayer;
        const mine = me === null ? undefined : playerKey(me.id);
        const scores = field<Scoreboard>(rt, GAME_KEY, FIELD_SCORES);
        const board = field<Leaderboard>(rt, GAME_KEY, FIELD_BOARD);

        return {
            phase: field<MatchPhase>(rt, GAME_KEY, STATE_PHASE) ?? 'lobby',
            secondsLeft: field<number>(rt, GAME_KEY, STATE_SECONDS_LEFT) ?? 0,
            readyCount: field<number>(rt, GAME_KEY, STATE_READY_COUNT) ?? 0,
            playerCount: field<number>(rt, GAME_KEY, STATE_PLAYER_COUNT) ?? 0,
            winnerName: field<string>(rt, GAME_KEY, STATE_WINNER) ?? '',
            wasted: field<number>(rt, GAME_KEY, STATE_WASTED) ?? 0,
            round: field<number>(rt, GAME_KEY, STATE_ROUND) ?? 0,
            // A peer holding no scripts still holds a real `Scoreboard`: the mirror revives one from
            // the payload's own tag, so `of` and `top` answer here exactly as they do on the server.
            score: me === null ? 0 : (scores?.of(me) ?? 0),
            lifetime: mine === undefined ? 0 : (field<number>(rt, mine, STATE_LIFETIME) ?? 0),
            best: mine === undefined ? 0 : (field<number>(rt, mine, STATE_BEST) ?? 0),
            ready: mine === undefined ? false : field<boolean>(rt, mine, STATE_READY) === true,
            slot: mine === undefined ? 0 : (field<number>(rt, mine, STATE_SLOT) ?? 0),
            ranks: rankRows(board),
        };
    }

    #write(next: MatchState, force: boolean): void {
        const was = this.#last;
        this.#last = next;
        const phaseMoved = force || next.phase !== was.phase;

        // FIRST, before any widget write. `hud.open` dispatches the screen's `@onStart` inside the
        // call, and `LobbyScreen` writes the ready button's placeholder there — so opening after
        // this method's own writes would let the placeholder win, and the diff below would not
        // rewrite it until the authority's answer next changed.
        this.#writeScreens(next);

        if (force || next.round !== was.round || phaseMoved) {
            hud.text(WIDGET_PHASE, describePhase(next));
        }
        if (force || next.secondsLeft !== was.secondsLeft || phaseMoved) {
            hud.number(WIDGET_CLOCK, next.secondsLeft);
            hud.bar(
                WIDGET_CLOCK,
                next.phase === 'playing' ? clamp01(next.secondsLeft / ROUND_SECONDS) : 0,
            );
            this.#drawClock(next);
        }
        if (force || next.score !== was.score) hud.number(WIDGET_SCORE, next.score);
        if (force || next.lifetime !== was.lifetime) hud.number(WIDGET_LIFETIME, next.lifetime);
        if (force || next.best !== was.best) hud.number(WIDGET_BEST, next.best);
        if (force || next.wasted !== was.wasted) hud.number(WIDGET_WASTED, next.wasted);
        if (force || next.winnerName !== was.winnerName) hud.text(WIDGET_WINNER, next.winnerName);
        if (force || next.slot !== was.slot) hud.number(WIDGET_SLOT, next.slot);

        // The authority's answer, which corrects whatever `LobbyScreen` said locally on the press —
        // and it is written after the open above for exactly that reason. `playerCount` is in the
        // guard because the label renders it: a second tab joining changes nothing else.
        if (
            force ||
            next.ready !== was.ready ||
            next.readyCount !== was.readyCount ||
            next.playerCount !== was.playerCount ||
            phaseMoved
        ) {
            hud.text(WIDGET_READY, describeReady(next));
            hud.enable(WIDGET_READY, next.phase === 'lobby' && !next.ready);
        }

        this.#writeRanks(next, was, force);
    }

    #writeRanks(next: MatchState, was: MatchState, force: boolean): void {
        for (let row = 0; row < BOARD_SIZE; row++) {
            const line = next.ranks[row] ?? '';
            if (!force && line === (was.ranks[row] ?? '')) continue;
            hud.text(rankWidget(row), line);
            if (line === '') hud.hide(rankWidget(row));
            else hud.show(rankWidget(row));
        }
    }

    /** One screen at a time, and only on a transition — an open runs its scripts' `@onStart`. */
    #writeScreens(next: MatchState): void {
        const want =
            next.phase === 'results'
                ? SCREEN_RESULTS
                : next.phase === 'lobby'
                  ? SCREEN_LOBBY
                  : null;
        if (want === this.#shown) return;
        if (this.#shown !== null) hud.close(this.#shown);
        if (want !== null) hud.open(want);
        this.#shown = want;
    }

    /**
     * The round clock, drawn on the renderer's `ui` surface.
     *
     * Screen space, so it neither scrolls with the camera nor culls — and text is legal only there:
     * a text node on a camera-transformed surface throws, and world text is an asset instead.
     */
    #drawClock(next: MatchState): void {
        const label = next.phase === 'playing' ? String(next.secondsLeft) : '';
        const node = this.#clockNode;
        if (node === undefined) {
            this.#clockNode = this.#renderer.createNode({
                kind: 'text',
                surface: 'ui',
                uiAnchor: 'top-center',
                position: { x: 0, y: CLOCK_OFFSET_Y, z: 0 },
                text: label,
                style: CLOCK_STYLE,
            });
            return;
        }
        if (this.#renderer.isAlive(node)) this.#renderer.setNodeText(node, label);
    }
}

/** The ranked rows, as a client holding no scripts reads them back off the revived board. */
function rankRows(board: Leaderboard | undefined): string[] {
    if (board === undefined) return [];
    // `top` resolves each id through the runtime's roster, so it answers only under `withRuntime`.
    return board
        .top(BOARD_SIZE)
        .map(
            (row: { player: Player; score: number }, index: number) =>
                `${index + 1}. ${row.player.name} — ${row.score}`,
        );
}

function describePhase(state: MatchState): string {
    switch (state.phase) {
        case 'lobby':
            return state.round === 0 ? 'ready up to start' : `round ${state.round} over`;
        case 'playing':
            return `round ${state.round}`;
        case 'results':
            return state.winnerName === '' ? 'nobody scored' : `${state.winnerName} wins`;
    }
}

function describeReady(state: MatchState): string {
    if (state.phase !== 'lobby') return `${state.playerCount} playing`;
    if (state.ready) return `waiting — ${state.readyCount}/${state.playerCount} ready`;
    return `ready up (${state.readyCount}/${state.playerCount})`;
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
}
