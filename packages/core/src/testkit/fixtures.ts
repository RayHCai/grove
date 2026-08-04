// Decorator-bearing fixtures compiled by the build (tsc lowers standard decorators; the
// test runner's oxc transform does not — DESIGN §3.3). Tests import the compiled classes
// from dist and assert behavior; test files themselves carry no decorator syntax.
//
// Not part of the public surface — exported only so the test suite can reach it.

import { ServerScript, SyncedScript } from '../script/bases.js';
import { onCollide, onEvent, onStart, serverState } from '../script/decorators.js';
import type { Entity } from '../runtime/entity.js';
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
    // Inherits the parent's @onEvent('jump') registration; overriding the body must NOT
    // re-register (DESIGN §3.2). No decorator here on purpose.
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

// An entity-hosted gameplay script: @serverState health, a damage event, a collide
// handler, and a synchronous destroy — the §5.8 "crate.alive === false after send" contract.
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

// A handler that awaits, for the cancellation / concurrency tests.
export class Cooldown extends SyncedScript<Entity> {
    fires = 0;

    @onEvent('attack', { concurrency: 'ignore' })
    async attack(): Promise<void> {
        this.fires += 1;
        await new Promise<void>(() => {
            /* never resolves — models a cooldown held open */
        });
    }
}
