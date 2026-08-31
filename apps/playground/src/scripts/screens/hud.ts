// The always-on overlay: replicated state in, widgets out, once a frame.
//
// This is the whole HUD, and it is a SCRIPT rather than anything in the host app. Nothing here
// diffs: writing an unchanged widget is free, because the sink compares before it notifies.
//
// It also owns which menu is up, because the phase is the only input to that and `render` already
// reads the phase every frame.

import type { HUDScreen, Leaderboard, Player, Scoreboard } from '@platform/engine';
import { ClientScript, game, hud, onUpdate } from '@platform/engine';
import type { MatchPhase } from '../globals.js';
import {
    BOARD_SIZE,
    ROUND_SECONDS,
    SCREEN_LOBBY,
    SCREEN_RESULTS,
    STATE_BEST,
    STATE_BOARD,
    STATE_LIFETIME,
    STATE_PHASE,
    STATE_PLAYER_COUNT,
    STATE_READY,
    STATE_READY_COUNT,
    STATE_ROUND,
    STATE_SCORES,
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
} from '../globals.js';
import { readState } from '../state.js';

export class HudScreen extends ClientScript<HUDScreen> {
    /** The screen this one last opened, so a phase change closes exactly what it opened. */
    #shown: string | null = null;

    @onUpdate
    render(): void {
        // The mirror hoists every replicated field onto the facade it belongs to as it lands, so
        // these read the same names the authority wrote.
        const world = game;
        // Declared non-null on a `ClientScript`, but a screen can open before the roster carries the
        // local player — the welcome is what seats them.
        const me = this.localPlayer as Player | undefined;
        const phase = readState<MatchPhase>(world, STATE_PHASE) ?? 'lobby';
        const round = readState<number>(world, STATE_ROUND) ?? 0;
        const secondsLeft = readState<number>(world, STATE_SECONDS_LEFT) ?? 0;
        const readyCount = readState<number>(world, STATE_READY_COUNT) ?? 0;
        const playerCount = readState<number>(world, STATE_PLAYER_COUNT) ?? 0;
        const winner = readState<string>(world, STATE_WINNER) ?? '';

        // BEFORE the widgets below: opening runs the new screen's `@onStart`, and a placeholder
        // written there must not survive the authoritative value this frame already holds.
        this.#showFor(phase);

        hud.text(WIDGET_PHASE, describePhase(phase, round, winner));
        hud.number(WIDGET_CLOCK, secondsLeft);
        hud.bar(WIDGET_CLOCK, phase === 'playing' ? clamp01(secondsLeft / ROUND_SECONDS) : 0);
        hud.number(WIDGET_WASTED, readState<number>(world, STATE_WASTED) ?? 0);
        hud.text(WIDGET_WINNER, winner);

        // A peer holding no scripts still holds a real `Scoreboard`: the mirror revives one from the
        // payload's own tag, so `of` and `top` answer here as they do on the server.
        const scores = readState<Scoreboard>(world, STATE_SCORES);
        hud.number(WIDGET_SCORE, me === undefined ? 0 : (scores?.of(me) ?? 0));

        const ready = readState<boolean>(me, STATE_READY) === true;
        hud.number(WIDGET_LIFETIME, readState<number>(me, STATE_LIFETIME) ?? 0);
        hud.number(WIDGET_BEST, readState<number>(me, STATE_BEST) ?? 0);
        hud.number(WIDGET_SLOT, readState<number>(me, STATE_SLOT) ?? 0);
        hud.text(WIDGET_READY, describeReady(phase, ready, readyCount, playerCount));
        hud.enable(WIDGET_READY, phase === 'lobby' && !ready);

        this.#writeBoard(readState<Leaderboard>(world, STATE_BOARD));
    }

    /** One menu at a time, and only on a transition — an open runs its scripts' `@onStart`. */
    #showFor(phase: MatchPhase): void {
        const want = phase === 'results' ? SCREEN_RESULTS : phase === 'lobby' ? SCREEN_LOBBY : null;
        if (want === this.#shown) return;
        if (this.#shown !== null) hud.close(this.#shown);
        if (want !== null) hud.open(want);
        this.#shown = want;
    }

    /** The ranked rows, as one widget each, so the table travels like every other value. */
    #writeBoard(board: Leaderboard | undefined): void {
        const rows = board?.top(BOARD_SIZE) ?? [];
        for (let row = 0; row < BOARD_SIZE; row++) {
            const entry = rows[row];
            const line =
                entry === undefined ? '' : `${row + 1}. ${entry.player.name} — ${entry.score}`;
            hud.text(rankWidget(row), line);
            if (line === '') hud.hide(rankWidget(row));
            else hud.show(rankWidget(row));
        }
    }
}

function describePhase(phase: MatchPhase, round: number, winner: string): string {
    switch (phase) {
        case 'lobby':
            return round === 0 ? 'ready up to start' : `round ${round} over`;
        case 'playing':
            return `round ${round}`;
        case 'results':
            return winner === '' ? 'nobody scored' : `${winner} wins`;
    }
}

function describeReady(
    phase: MatchPhase,
    ready: boolean,
    readyCount: number,
    playerCount: number,
): string {
    if (phase !== 'lobby') return `${playerCount} playing`;
    if (ready) return `waiting — ${readyCount}/${playerCount} ready`;
    return `ready up (${readyCount}/${playerCount})`;
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
}
