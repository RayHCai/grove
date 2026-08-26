import { SyncedScript, onUpdate } from '@platform/core';
import type { Ctx, Entity } from '@platform/core';

/** Every line the pass has to refuse, in the one place it is scoped to. */
export class Drifter extends SyncedScript<Entity> {
    x = 0;

    @onUpdate
    advance(ctx: Ctx): void {
        this.x += Math.sin(Date.now()) * ctx.dt;
    }
}
