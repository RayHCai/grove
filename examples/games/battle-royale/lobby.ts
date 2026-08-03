// The `lobby` screen — ready-up, player count, leaderboard.
//
//   Greenhouse  ClientScript<HUDScreen>  the whole screen
//
// A screen exists on one machine, so ClientScript is its only legal location (§12.2).
// Everything here is local until the one `request`.

import { ClientScript, game, hud, onPress, onUpdate, request } from '@platform/engine';
import type { HUDScreen } from '@platform/engine';

import { TO_START } from './game.js';
import { fighter, world } from './state.js';

export class Greenhouse extends ClientScript<HUDScreen> {
    pending = false;

    @onPress('ready')
    ready() {
        this.pending = true;
        request('ready');
    }

    @onUpdate
    render() {
        const state = world();
        const me = fighter(this.localPlayer);
        const ready = game.players.filter((p) => fighter(p).isReady).length;

        hud.text('lobby-title', state.phase === 'over' ? 'Round over' : 'Greenhouse');
        hud.text('lobby-count', `${ready}/${game.players.length} ready`);
        hud.text(
            'lobby-hint',
            game.players.length < TO_START ? 'Waiting for another sprout…' : 'Ready when you are',
        );

        // The local branch that replaced the `for:` option (§12.3).
        const who = state.winner === this.localPlayer.name ? 'You' : state.winner;
        hud.text('lobby-result', state.winner === '' ? '' : `${who} won that one.`);

        // Show that you asked, not that it worked (§12.7); replication clears it.
        if (me.isReady) this.pending = false;
        hud.enable('ready', !this.pending && !me.isReady);

        hud.text(
            'lobby-board',
            state.board.map((r, i) => `${i + 1}. ${r.name} — ${r.wins}`).join('\n'),
        );
    }
}
