// tsc lowers standard decorators and the test runner's transform does not, so these fixtures
// are compiled by the build and the tests import them from dist.

import { ClientScript, ServerScript, SyncedScript } from '../script/bases.js';
import {
    onClick,
    onCollide,
    onEnd,
    onEnter,
    onEvent,
    onEventHold,
    onEventRelease,
    onExit,
    onHoverEnter,
    onHoverExit,
    onPlayerJoin,
    onPress,
    onPlayerLeave,
    onRequest,
    onStart,
    onUpdate,
    serverState,
} from '../script/decorators.js';
import type { ScriptProps } from '@platform/project';
import type { Camera } from '../runtime/camera.js';
import type { Entity } from '../runtime/entity.js';
import type { Game } from '../runtime/game.js';
import type { HUDScreen } from '../runtime/hud.js';
import { BaseMovement } from '../runtime/movement.js';
import type { Player } from '../runtime/player.js';
import type { Ctx } from '../runtime/ctx.js';

export class Wallet extends ServerScript {
    @serverState credits = 10;
    @serverState label = 'anon';
    plain = 5;
}

export class Movement extends SyncedScript {
    jumps = 0;

    @onEvent('jump')
    jump(): void {
        this.jumps += 1;
    }

    @onStart
    begin(): void {
        this.jumps = 0;
    }
}

export class DoubleJump extends Movement {
    // No decorator on purpose: overriding the body must not re-register the parent's handler.
    override jump(): void {
        this.jumps += 2;
    }
}

export class Sibling extends Movement {
    @onEvent('dash')
    dash(): void {
        this.jumps += 10;
    }
}

// The destroy is synchronous, which is what makes `alive === false` right after `send` testable.
export class Target extends SyncedScript<Entity> {
    @serverState health = 3;
    @serverState downed = false;

    @onEvent('damage')
    hurt(ctx: Ctx): void {
        this.health -= (ctx.data.amount as number) ?? 0;
        if (this.health <= 0) {
            this.downed = true;
            this.host.destroy();
        }
    }

    @onCollide('hazard')
    touchHazard(): void {
        this.health -= 1;
    }
}

// The pending promise is exposed so a test can settle the await deterministically, and this base
// declares no handler because a decorated one here would register on both subclasses.
abstract class Parked extends SyncedScript<Entity> {
    #release: (() => void) | null = null;

    protected park(): Promise<void> {
        return new Promise<void>((resolve) => {
            this.#release = resolve;
        });
    }

    release(): void {
        const r = this.#release;
        this.#release = null;
        r?.();
    }
}

export class Cooldown extends Parked {
    fires = 0;
    completions = 0;

    @onEvent('attack', { concurrency: 'ignore' })
    async attack(): Promise<void> {
        this.fires += 1;
        await this.park();
        this.completions += 1;
    }
}

export class Aimer extends Parked {
    starts = 0;
    finishes = 0;

    @onEvent('aim', { concurrency: 'restart' })
    async aim(): Promise<void> {
        this.starts += 1;
        await this.park();
        this.finishes += 1;
    }
}

export class AsyncFaulty extends SyncedScript<Entity> {
    @onEvent('boom')
    async boom(): Promise<void> {
        await Promise.resolve();
        throw new Error('async handler always throws');
    }
}

export class Nester extends SyncedScript<Entity> {
    nestedRuns = 0;

    /** A callback, not a runtime read: dist fixtures and src tests hold different globals. */
    afterNestedSend: (() => void) | null = null;

    @onEvent('outer')
    outer(): void {
        (this.host as unknown as { send(event: string): unknown }).send('inner');
        this.afterNestedSend?.();
    }

    @onEvent('inner')
    inner(): void {
        this.nestedRuns += 1;
    }
}

export class Faulty extends SyncedScript<Entity> {
    @onEvent('boom')
    boom(): void {
        throw new Error('handler always throws');
    }
}

// `accelerate` is the stage every movement subclass must supply, and the movement pass calls it
// through `tick` with no dispatch — so this throws where the dispatcher's boundary does not reach.
export class FaultyMovement extends BaseMovement {
    protected accelerate(): void {
        throw new Error('accelerate always throws');
    }
}

// @onRequest is legal only on a ServerScript, which is why this fixture is one.
export class Rules extends ServerScript {
    @serverState started = false;
    @serverState credits = 0;

    @onStart
    begin(): void {
        this.started = true;
    }

    @onRequest('grant')
    grant(ctx: Ctx): void {
        this.credits += (ctx.data.amount as number) ?? 0;
    }
}

// Three phases on one action: without the dispatcher's phase filter one press fires all three.
export class PhaseProbe extends SyncedScript<Entity> {
    presses = 0;
    releases = 0;
    holds = 0;

    @onEvent('jump')
    press(): void {
        this.presses += 1;
    }

    @onEventRelease('jump')
    release(): void {
        this.releases += 1;
    }

    @onEventHold('jump')
    hold(): void {
        this.holds += 1;
    }
}

export class Roll extends ServerScript {
    joined: string[] = [];
    left: string[] = [];
    /** A callback, not a runtime read: dist fixtures and src tests hold different globals. */
    probe: (() => void) | null = null;

    @onPlayerJoin
    join(ctx: Ctx): void {
        this.joined.push((ctx.player as { id: string }).id);
    }

    @onPlayerLeave
    leave(ctx: Ctx): void {
        this.left.push((ctx.player as { id: string }).id);
        this.probe?.();
    }
}

/** Roster handlers that call back into the test, which holds the globals a dist fixture cannot see. */
export class RosterProbe extends ServerScript<Game> {
    onJoin: (() => void) | null = null;
    onLeave: (() => void) | null = null;

    @onPlayerJoin
    join(): void {
        this.onJoin?.();
    }

    @onPlayerLeave
    leave(): void {
        this.onLeave?.();
    }
}

/** `players` is a getter on Game, so hoisting this would replace the roster with a number. */
export class ShadowsGameGetter extends ServerScript<Game> {
    @serverState players = 0;
}

/** `spawn` is a method on Game — a value hoisted over one is not callable. */
export class ShadowsGameMethod extends ServerScript<Game> {
    @serverState spawn = 0;
}

/** `name` is an own field on Player, which a hoist skips rather than shadows. */
export class ShadowsPlayerField extends ServerScript<Player> {
    @serverState name = 'shadow';
}

/** `avatar` is a getter on Player, so this one would shadow rather than skip. */
export class ShadowsPlayerGetter extends ServerScript<Player> {
    @serverState avatar = 0;
}

// The tick order's edges on one host: a region crossing, a contact's enter edge, and the host's end.
export class Edges extends SyncedScript<Entity> {
    entered: string[] = [];
    exited: string[] = [];
    contacts = 0;
    ends = 0;
    /** A callback, not a runtime read: dist fixtures and src tests hold different globals. */
    probe: (() => void) | null = null;

    @onEnter('arena')
    arriveArena(): void {
        this.entered.push('arena');
    }

    @onExit('arena')
    leaveArena(): void {
        this.exited.push('arena');
    }

    @onCollide('hazard')
    touch(): void {
        this.contacts += 1;
    }

    @onEnd
    finish(): void {
        this.ends += 1;
        this.probe?.();
    }
}

// @onEnd on a Player host means the session ended, which is a different moment from @onPlayerLeave.
export class Session extends ServerScript {
    ends = 0;
    /** A callback, not a runtime read: dist fixtures and src tests hold different globals. */
    probe: (() => void) | null = null;

    @onEnd
    finish(): void {
        this.ends += 1;
        this.probe?.();
    }
}

// ClientScript is the only legal location on a screen host, so a screen fixture is one by necessity.
export class Menu extends ClientScript<HUDScreen> {
    starts = 0;
    ends = 0;
    pressed: string[] = [];

    @onStart
    begin(): void {
        this.starts += 1;
    }

    @onEnd
    finish(): void {
        this.ends += 1;
    }

    @onPress('buy')
    buy(): void {
        this.pressed.push('buy');
    }

    @onPress('back')
    back(): void {
        this.pressed.push('back');
    }
}

// The same `back` button name on a second screen: only the pressed screen's handler may fire.
export class OtherMenu extends ClientScript<HUDScreen> {
    pressed: string[] = [];

    @onPress('back')
    back(): void {
        this.pressed.push('back');
    }
}

// A press handler off a screen resolves the widget across the whole HUD, not one screen's buttons.
export class Shopper extends ClientScript {
    pressed: string[] = [];

    @onPress('back')
    back(): void {
        this.pressed.push('back');
    }
}

// @onRequest on a non-ServerScript is a wire-time error; this fixture is that rejection case.
export class SyncedWithRequest extends SyncedScript<Entity> {
    @onRequest('illegal')
    handle(): void {
        /* the location, not the body, is what wire time rejects */
    }
}

/**
 * Ctor props: a class that reads them at construction and two `@serverState` fields.
 *
 * `speed` is what an inspector configures; `label` is what it leaves alone. The engine writes both
 * kinds of field, so a props-free attach must still land the initializer.
 */
export class Configured extends ServerScript<Entity> {
    @serverState speed = 1;
    @serverState label = 'default';

    /** Derived at construction, before the engine writes anything — never a field props name. */
    readonly configuredKeys: string[];

    constructor(props?: ScriptProps) {
        super();
        this.configuredKeys = Object.keys(props ?? {}).toSorted();
    }
}

/** Attached from a player-join handler, which runs between ticks — so its @onStart is deferred. */
export class LateJoiner extends ServerScript<Player> {
    @serverState greeted = false;

    @onStart
    begin(): void {
        this.greeted = true;
    }
}

/** The case a deferred start exists for: a script attached from outside any tick. */
export class Greeter extends ServerScript {
    @onPlayerJoin
    join(ctx: Ctx): void {
        ctx.player?.addScript(LateJoiner);
    }
}

// Pass 9. Synced, so the same class is the one a client would run under prediction — which is why
// the update pass forcing the server's locations is a claim worth an assertion of its own.
export class Ticker extends SyncedScript<Entity> {
    updates = 0;
    lastDt = 0;

    @onUpdate
    tick(ctx: Ctx): void {
        this.updates += 1;
        this.lastDt = ctx.dt;
    }
}

/** The same handler on a ClientScript, which pass 9 must NOT run — `displayUpdate` owns it. */
export class ClientTicker extends ClientScript<Entity> {
    updates = 0;

    @onUpdate
    tick(): void {
        this.updates += 1;
    }
}

/** An `@onUpdate` that throws, for the log record the pass writes about it. */
export class FaultyTicker extends SyncedScript<Entity> {
    @onUpdate
    tick(): void {
        throw new Error('update always throws');
    }
}

// The three pointer edges are three handler kinds rather than one with an argument, so each is
// matched on kind alone and a fixture declaring all three proves they do not cross.
export class Pointed extends SyncedScript<Entity> {
    clicks = 0;
    entered = 0;
    exited = 0;
    lastPlayer: string | null = null;
    /** Whichever of `other`/`player` the hit carried, so the ctx shape is assertable. */
    sawOther = false;

    @onClick
    click(ctx: Ctx): void {
        this.clicks += 1;
        this.lastPlayer = (ctx.player as { id: string } | undefined)?.id ?? null;
        this.sawOther = ctx.other !== undefined;
    }

    @onHoverEnter
    hoverIn(): void {
        this.entered += 1;
    }

    @onHoverExit
    hoverOut(): void {
        this.exited += 1;
    }
}

/** A SyncedScript on a camera host: the rejection, since a camera has no authoritative copy. */
export class Viewfinder extends SyncedScript<Camera> {
    @onStart
    begin(): void {
        /* the location and the host kind are what wire time rejects, never the body */
    }
}

/** A roster handler off a ServerScript: the other half of the Game-hosted-only rule. */
export class SyncedRoster extends SyncedScript<Entity> {
    @onPlayerJoin
    join(): void {
        /* the location, not the body, is what wire time rejects */
    }
}

/** A second class claiming `credits`, which `Wallet` already declares — one name, one host. */
export class RivalWallet extends ServerScript {
    @serverState credits = 99;
}

/** Overrides `tick`, which is the one stage of the movement contract a subclass may not replace. */
export class TickOverridingMovement extends BaseMovement {
    override tick(): void {
        /* the override itself is the rejection; the body never runs */
    }

    protected accelerate(): void {}
}
