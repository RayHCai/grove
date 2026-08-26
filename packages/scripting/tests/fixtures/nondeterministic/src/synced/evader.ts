import { SyncedScript, onUpdate } from '@platform/core';
import type { Ctx, Entity } from '@platform/core';

/** The three ways round a member check: an alias, a computed member, and the global object. */
export class Evader extends SyncedScript<Entity> {
    x = 0;

    @onUpdate
    advance(ctx: Ctx): void {
        const m = Math;
        this.x = m.cos(ctx.dt) + Math['tan'](ctx.dt);
        this.x += (globalThis as { seed?: number }).seed ?? 0;
    }
}
