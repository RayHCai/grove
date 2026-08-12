// Decorator-bearing fixtures compiled by the build: `tsc` lowers standard decorators and the test
// runner's transform does not, so the tests import the compiled classes from `../dist/testkit/` and
// carry no decorator syntax themselves.
//
// Not public surface — exported only so the test suite can reach it, and the one place in this package
// that touches core's decorated surface: `src/` proper drives core as values and declares no script.

import type { Ctx, Entity, Player } from '@platform/core';
import {
    ServerScript,
    SyncedScript,
    onEvent,
    onEventHold,
    onEventRelease,
    onPlayerJoin,
    onPlayerLeave,
    onStart,
    serverState,
} from '@platform/core';

/** Every input phase on one action, so a phase-filter test can tell them apart. */
export class Recorder extends SyncedScript<Entity> {
    presses = 0;
    releases = 0;
    holds = 0;
    lastValue = 0;

    @onEvent('jump')
    onPress(): void {
        this.presses += 1;
    }

    @onEventRelease('jump')
    onRelease(): void {
        this.releases += 1;
    }

    @onEventHold('jump')
    onHold(ctx: Ctx): void {
        this.holds += 1;
        this.lastValue = ctx.value ?? 0;
    }
}

/** A second action, to prove a dispatch for `jump` reaches nothing declared against `dash`. */
export class Dasher extends SyncedScript<Entity> {
    dashes = 0;

    @onEventHold('dash')
    onDash(): void {
        this.dashes += 1;
    }
}

/** Entity-hosted `@serverState`, the baseline a joiner must receive. */
export class Health extends SyncedScript<Entity> {
    @serverState health = 3;
}

/** Player-hosted `@serverState` — replicated to its owner alone. */
export class Wallet extends ServerScript<Player> {
    @serverState credits = 10;
}

/** The Game-hosted `ServerScript` the roster events are declarable on, and nowhere else. */
export class Rules extends ServerScript {
    @serverState round = 1;
    joined: string[] = [];
    left: string[] = [];
    started = false;

    @onStart
    begin(): void {
        this.started = true;
    }

    @onPlayerJoin
    join(ctx: Ctx): void {
        const player = ctx.player as Player | undefined;
        if (!player) return;
        this.joined.push(player.id);
        player.spawn();
    }

    @onPlayerLeave
    leave(ctx: Ctx): void {
        const player = ctx.player as Player | undefined;
        if (player) this.left.push(player.id);
    }
}

/** A Game script whose `@onPlayerJoin` spectates instead, for the bodiless-player paths. */
export class Spectators extends ServerScript {
    @onPlayerJoin
    join(ctx: Ctx): void {
        (ctx.player as Player | undefined)?.spectate();
    }
}
