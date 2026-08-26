import { onUpdate, serverState } from '@platform/core';
import type { Ctx } from '@platform/core';
import { drift } from '../shared.js';
import { Movable } from './base.js';

/** Runs on both ends, which is exactly why it may read no clock and draw no unseeded number. */
export class Runner extends Movable {
    @serverState x = 0;

    @onUpdate
    advance(ctx: Ctx): void {
        // Math.floor stays legal: it is exactly specified, so it already agrees everywhere.
        this.x = Math.floor(drift(this.x, ctx.dt));
    }

    // `history` is a DOM global and a parameter name here; the pass must see the binding.
    recent(history: readonly number[]): number {
        return history.length;
    }
}
