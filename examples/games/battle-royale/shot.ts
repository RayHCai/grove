// The `shot` template — one pellet: travel, hit, self-destruct.
//
//   Shot  SyncedScript<Entity>  the whole pellet
//
// Added by `Gunplay` at spawn rather than panel-attached, since this template is
// spawned by code (fighter.ts).

import { SyncedScript, cos, onCollide, onEvent, sin } from '@platform/engine';
import type { Ctx, Entity } from '@platform/engine';

export class Shot extends SyncedScript<Entity> {
    damage = 1;
    shooter: Entity | null = null;

    @onEvent('launch')
    async travel(ctx: Ctx) {
        this.damage = ctx.data.damage as number;
        this.shooter = ctx.data.from as Entity;

        this.host.faceToward({ x: ctx.data.x as number, y: ctx.data.y as number, z: 0 });
        this.host.rotateBy(ctx.data.angle as number); // this pellet's own line

        // The weapon's range, not the cursor, so a miss still expires where the
        // weapon says. The trig is the text-tier escape hatch.
        const range = ctx.data.range as number;
        const rad = (this.host.rotation * Math.PI) / 180;
        await this.host.glideBy(cos(rad) * range, sin(rad) * range, 0.35);

        if (this.host.alive) this.host.destroy();
    }

    @onCollide('fighter')
    hit(ctx: Ctx) {
        if (ctx.other === this.shooter) return; // not your own foot
        this.host.destroy();
        ctx.other!.send('hit', { amount: this.damage, by: this.shooter?.owner ?? null });
    }
}
