import { SyncedScript } from '@platform/core';
import type { Ctx, Entity } from '@platform/core';

/** Abstract, so the pass has to walk two links to reach a location and must not stamp an id here. */
export abstract class Movable extends SyncedScript<Entity> {
    abstract advance(ctx: Ctx): void;
}
