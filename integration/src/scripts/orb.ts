// What an orb IS: how it is spawned, how it drifts, what it is worth, and what the bonus region
// does to it.
//
// Server-located and entity-hosted, so a client holds no copy of this class and never simulates
// one — an orb reaches a tab as replicated transforms and replicated fields and nothing else.

import type { Ctx, Entity, Game } from '@platform/engine';
import {
    ServerScript,
    after,
    game,
    onClick,
    onEnter,
    onExit,
    onStart,
    onUpdate,
    serverState,
} from '@platform/engine';
import {
    ORB_BONUS_VALUE,
    ORB_HALF,
    ORB_LIFETIME,
    ORB_VALUE,
    REGION_BONUS,
    TAG_ORB,
    TEMPLATE_ORB,
    WORLD,
} from '../globals.js';
import { Ledger } from './ledger.js';

/**
 * Spawns one orb drifting at `drift` world units a second.
 *
 * Left unowned deliberately: the server destroys every entity whose `ownerId` matches a departing
 * player, and an orb belongs to the world rather than to a person.
 */
export function spawnOrb(world: Game, y: number, drift: number): Entity {
    const orb = world.spawn(TEMPLATE_ORB, WORLD.left + ORB_HALF, y);
    orb.tag(TAG_ORB);
    // Assigned here and nowhere else: nothing in the engine, the manifest or the template system
    // writes a collider, so `@onCollide` answers nothing at all until one exists.
    orb.collider = {
        enabled: true,
        isTrigger: true,
        bounds: { left: -ORB_HALF, right: ORB_HALF, top: ORB_HALF, bottom: -ORB_HALF },
    };
    // The template attached `Orb` inside `spawn`, so the instance is already here to write through.
    const script = orb.getScript(Orb);
    if (script !== null) script.drift = drift;
    return orb;
}

/** Every orb on the stage. Avatars carry colliders too; the tag is what tells them apart. */
export function liveOrbs(world: Game): Entity[] {
    return world.find({ tag: TAG_ORB });
}

export class Orb extends ServerScript<Entity> {
    /** Entity-hosted, so it replicates: a tab can be asked what it believes an orb is worth. */
    @serverState value = ORB_VALUE;
    @serverState ripe = false;

    /** World units a second, signed. Written by `spawnOrb` between construction and the hoist. */
    drift = 0;

    @onStart
    born(): void {
        // An orb nobody reaches retires itself. The timer is cancelled with its host, so one
        // collected first leaves nothing behind to fire.
        after(ORB_LIFETIME, () => this.host.destroy());
    }

    @onEnter(REGION_BONUS)
    enrich(): void {
        this.ripe = true;
        this.value = ORB_BONUS_VALUE;
        game.getScript(Ledger)?.noteRipe();
    }

    @onExit(REGION_BONUS)
    cool(): void {
        this.ripe = false;
        this.value = ORB_VALUE;
        game.getScript(Ledger)?.noteCool();
    }

    /** Turned at the wall rather than destroyed, so the lifetime timer stays the only reaper. */
    @onUpdate
    travel(ctx: Ctx): void {
        const at = this.host.position;
        const x = at.x + this.drift * ctx.dt;
        if (x > WORLD.right - ORB_HALF || x < WORLD.left + ORB_HALF) {
            this.drift = -this.drift;
            return;
        }
        this.host.setPosition(x, at.y);
    }

    /**
     * A pointer hit the browser resolved against its own camera, which no authority can recompute.
     *
     * Worth what walking into it is worth: the reach is the difference, not the payout.
     */
    @onClick
    pop(ctx: Ctx): void {
        const player = ctx.player;
        if (!player || !this.host.alive) return;
        game.getScript(Ledger)?.steal(player, this.value);
        this.host.destroy();
    }
}
