// The `sprout` template — the avatar, the body identity drives (§3.2).
//
//   SproutMovement  PlatformerMovement     coyote time, and a kinder jump
//   Sprout          SyncedScript<Entity>   the movement knobs
//   View            ClientScript<Entity>   the camera, and the squash on landing
//
// Synced for the body, client for the flourish — the §1.1 grid down one column.
// There is no server script here: dying is a level rule, so it lives in game.ts.
// The panel fills the movement slot, which is why `Sprout` only tunes numbers (§4.1).

import {
    ClientScript,
    PlatformerMovement,
    SyncedScript,
    onStart,
    onUpdate,
    serverState,
    sound,
} from '@platform/engine';
import type { Entity } from '@platform/engine';

// Worth a subclass: coyote time is a new mechanic, not a number the panel already
// exposes (§4.1). Overriding `applyForces` and `jump` — never `tick`, which is sealed.
export class SproutMovement extends PlatformerMovement {
    // Per-entity, since movement is Entity-hosted (§6.1), and replicated so a late
    // jump replays the same on both sides.
    @serverState coyote = 0;

    grace = 0.1; // seconds after walking off a ledge that a jump still works

    protected override applyForces(dt: number) {
        super.applyForces(dt);

        // Charged on the ground, spent in the air. dt-scaled, so the same grace at
        // 30 Hz as at 60.
        this.coyote = this.grounded ? this.grace : Math.max(0, this.coyote - dt);
    }

    // Inherits the parent's `@onEvent('jump')`: re-declaring it in a subclass would
    // fire the action twice (§4.1).
    override jump() {
        if (!this.grounded && this.coyote <= 0) return;
        this.coyote = 0; // no double jump falls out of spending it
        super.jump();
    }
}

// Knobs, not a subclass — the common case §4.1 says to show first.
export class Sprout extends SyncedScript<Entity> {
    @onStart
    stand() {
        const movement = this.host.owner!.movement as SproutMovement;
        movement.walkSpeed = 300; // a run, not a stroll
        movement.jumpStrength = 560; // clears a two-tile gap
        movement.maxSpeed = 900; // terminal fall speed; the base's one ceiling
    }
}

// A squash is a fact about one screen — the cell that had no home before the grid
// (§1.1). @onUpdate here is display rate, not simRate (§12.2).
export class View extends ClientScript<Entity> {
    airborne = false;

    // Camera is the one thing client code may write (§3.3), and an Entity host's
    // @onStart means this body exists — so there is something to follow.
    @onStart
    look() {
        const camera = this.host.owner!.camera;
        camera.follow(this.host);
        camera.zoom = 1.2;
    }

    @onUpdate
    watch() {
        const movement = this.host.owner!.movement;
        if (!movement) return;

        // `blocked` is read the tick after resolution; there is no collision hook (§4.1).
        const grounded = movement.blocked.down;
        if (grounded && this.airborne) {
            sound.play('land', { at: this.host });
            this.host.playEffect('dust');
        }
        this.airborne = !grounded;
    }
}
