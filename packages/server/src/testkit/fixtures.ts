// Decorator-bearing fixtures compiled by the build: `tsc` lowers standard decorators and the test
// runner's transform does not, so the tests import the compiled classes from `../dist/testkit/` and
// carry no decorator syntax themselves.
//
// Not public surface — exported only so the test suite can reach it, and the one place in this package
// that touches core's decorated surface: `src/` proper drives core as values and declares no script.

import type { Ctx, Entity, Player } from '@platform/core';
import {
    Scoreboard,
    ServerScript,
    SyncedScript,
    Team,
    onClick,
    onEvent,
    onEventHold,
    onEventRelease,
    onHoverEnter,
    onHoverExit,
    onPlayerJoin,
    onPlayerLeave,
    onPress,
    onStart,
    onUpdate,
    serverState,
} from '@platform/core';

/** The authoritative half of a HUD press: the client resolved the widget, the server decides on it. */
export class Storekeeper extends ServerScript {
    @serverState credits = 0;
    presses: string[] = [];

    @onPress('buy')
    buy(ctx: Ctx): void {
        this.presses.push((ctx.player as Player | undefined)?.id ?? '(none)');
        this.credits += 1;
    }
}

/** Pointer hits, which land on the entity the client's own hit test named. */
export class Touchable extends SyncedScript<Entity> {
    clicks = 0;
    hoverEnters = 0;
    hoverExits = 0;

    @onClick
    clicked(): void {
        this.clicks += 1;
    }

    @onHoverEnter
    entered(): void {
        this.hoverEnters += 1;
    }

    @onHoverExit
    exited(): void {
        this.hoverExits += 1;
    }
}

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

/**
 * Game-hosted wrapper state: authoritative with no `@serverState`, marked by the wrapper itself.
 *
 * The field initializer is what binds it — wiring walks the instance's own properties — so a wrapper
 * whose constructor needs the host cannot be declared this way, which is why this one is a
 * `Scoreboard` and not an `Inventory`.
 */
export class Standings extends ServerScript {
    readonly scores = new Scoreboard();
}

/** Player-hosted wrapper state: a `Team` takes only a name, so a field initializer can build one. */
export class Squad extends ServerScript<Player> {
    readonly team = new Team('red');
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

/**
 * A Game script that attaches the player-hosted state inside `@onPlayerJoin`.
 *
 * Attaching there and not after the join is what makes the seeding order testable: the hoist reads
 * `rt.persisted` synchronously, so a record loaded too late seeds nothing and the test still passes
 * if the scripts are attached once the cache is already warm.
 */
export class Accounts extends ServerScript {
    @onPlayerJoin
    join(ctx: Ctx): void {
        const player = ctx.player as Player | undefined;
        if (!player) return;
        player.addScript(Wallet);
        player.addScript(Squad);
        player.spawn();
    }
}

/** A Game script whose `@onPlayerJoin` spectates instead, for the bodiless-player paths. */
export class Spectators extends ServerScript {
    @onPlayerJoin
    join(ctx: Ctx): void {
        (ctx.player as Player | undefined)?.spectate();
    }
}

/**
 * A Game script that throws every tick, so the breaker trips off nothing but a pump.
 *
 * `@onUpdate` needs no dispatch to provoke it, which is what makes a trip reachable from a test that
 * only advances the clock.
 */
export class FaultyRules extends ServerScript {
    @onUpdate
    update(): void {
        throw new Error('update always throws');
    }
}
