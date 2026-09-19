import { SyncedScript } from '@platform/core';
import type { Ctx, Entity } from '@platform/core';

/** Abstract, so the pass walks two links to a location and must not stamp an id here. */
export abstract class Movable extends SyncedScript<Entity> {
    abstract advance(ctx: Ctx): void;
}
