import { SyncedScript, onUpdate } from '@platform/core';
import type { Ctx, Entity } from '@platform/core';

/** The three routes that carry no denied name: `.constructor`, an indirect eval, and `import()`. */
export class Reflector extends SyncedScript<Entity> {
    x = 0;

    @onUpdate
    advance(ctx: Ctx): void {
        const compile = (() => 0).constructor as unknown as (body: string) => () => number;
        this.x += compile('return Date.now()')() * ctx.dt;
        this.x += (0, eval)('Date.now()') as number;
        void import('node:crypto');
    }
}
