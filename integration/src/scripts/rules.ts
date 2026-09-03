// The Game's own script: the roster, the seats, the drop timer and the scores.
//
// Every `@serverState` field is REASSIGNED wherever it changes — only the setter marks the
// replication channel, so a value mutated in place would replicate nothing.

import type { Ctx, Game, Player } from '@platform/engine';
import {
    ServerScript,
    every,
    onPlayerJoin,
    onPlayerLeave,
    onPress,
    onStart,
    onUpdate,
    serverState,
} from '@platform/engine';
import type { MatchPhase } from '../globals.js';
import {
    MAX_PLAYERS,
    ORB_BAND,
    ORB_INTERVAL,
    ORB_SPEED,
    WIDGET_SWEEP,
    avatarStart,
} from '../globals.js';
import { liveOrbs, spawnOrb } from './orb.js';
import { Profile } from './profile.js';

export class Rules extends ServerScript<Game> {
    /** Inspector values, written by the engine between construction and the `@serverState` hoist. */
    orbInterval = ORB_INTERVAL;

    /**
     * Game-hosted, so every peer sees these — a player-hosted field reaches only its owner.
     *
     * They land on the same host record `Ledger`'s do, since both scripts are attached to the Game:
     * two scripts declaring one name there is a load-time error, and these five are the roster's.
     */
    @serverState phase: MatchPhase = 'idle';
    @serverState seated = 0;
    @serverState orbs = 0;
    @serverState sweeps = 0;

    /**
     * The drop runs for the world's whole life and declines to drop while the stage is empty.
     *
     * One timer for the session rather than one started and cancelled per join: the phase check
     * below is what makes an empty stage cost nothing, and a per-join timer would have to be
     * cancelled on exactly the leave that removed the last player.
     */
    @onStart
    begin(): void {
        every(this.orbInterval, () => this.#drop());
    }

    /** `spawn()` owns the avatar to this player, which is what puts it in that client's predicted scope. */
    @onPlayerJoin
    join(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        player.addScript(Profile);
        const profile = player.getScript(Profile);
        if (profile !== null) {
            // The hoist seeded these from this player's saved record, so the per-session ones are
            // cleared rather than resumed.
            profile.seat = this.#freeSeat(player);
            profile.taken = 0;
        }
        player.spawn();
        this.#place(player);
        this.#recount();
    }

    /** The roster still holds the leaver here, which is why the recount is told who to leave out. */
    @onPlayerLeave
    leave(ctx: Ctx): void {
        this.#recount(ctx.player?.id);
    }

    /** A press rides the interaction frame, so `ctx.player` is engine-supplied rather than claimed. */
    @onPress(WIDGET_SWEEP)
    sweep(ctx: Ctx): void {
        if (!ctx.player) return;
        this.sweeps = this.sweeps + 1;
        for (const orb of liveOrbs(this.host)) orb.destroy();
        this.orbs = 0;
    }

    /** One write per change: the count is an integer, and marking the channel per tick is a wire nobody profiled. */
    @onUpdate
    census(): void {
        const live = liveOrbs(this.host).length;
        if (live !== this.orbs) this.orbs = live;
    }

    /**
     * The stage runs while anyone is on it and empties when the last of them goes.
     *
     * A world dropping orbs into an empty stage would grow the wire and the entity table for
     * nobody, and it is the transition a soak's join/leave churn crosses most often.
     */
    #recount(excluding?: string): void {
        const roster = this.host.players.filter((player) => player.id !== excluding);
        this.seated = roster.length;
        if (roster.length > 0) {
            this.phase = 'running';
            return;
        }
        this.phase = 'idle';
        for (const orb of liveOrbs(this.host)) orb.destroy();
        this.orbs = 0;
    }

    /** `game.random`, never `Math.random`: the snapshot store captures every draw, so a replay agrees. */
    #drop(): void {
        if (this.phase !== 'running') return;
        const world = this.host;
        const band = { low: -ORB_BAND, high: ORB_BAND };
        spawnOrb(
            world,
            world.random.between(band.low, band.high),
            world.random.chance(0.5) ? ORB_SPEED : ORB_SPEED * 1.5,
        );
    }

    /** The lowest seat no other live player holds. */
    #freeSeat(joining: Player): number {
        // The joining player is already on the roster carrying `Profile`'s initializer, so counting
        // their own default would push the first player of a session off seat zero.
        const held = new Set(
            this.host.players
                .filter((player) => player.id !== joining.id)
                .map((player) => player.getScript(Profile)?.seat),
        );
        for (let seat = 0; seat < MAX_PLAYERS; seat++) {
            if (!held.has(seat)) return seat;
        }
        return 0;
    }

    #place(player: Player): void {
        if (!player.hasAvatar) return;
        const at = avatarStart(player.getScript(Profile)?.seat ?? 0);
        player.teleportTo(at.x, at.y);
    }
}
