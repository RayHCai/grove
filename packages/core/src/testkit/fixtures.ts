// Decorator-bearing fixtures compiled by the build (tsc lowers standard decorators; the
// test runner's oxc transform does not — DESIGN §3.3). Tests import the compiled classes
// from dist and assert behavior; test files themselves carry no decorator syntax.
//
// Not part of the public surface — exported only so the test suite can reach it.

import { ServerScript, SyncedScript } from '../script/bases.js';
import { onCollide, onEvent, onRequest, onStart, serverState } from '../script/decorators.js';
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

// A handler that awaits, for the cancellation / concurrency tests. The pending promise is
// exposed so a test can settle it deterministically.
export class Cooldown extends SyncedScript<Entity> {
    fires = 0;
    completions = 0;
    #release: (() => void) | null = null;

    @onEvent('attack', { concurrency: 'ignore' })
    async attack(): Promise<void> {
        this.fires += 1;
        await new Promise<void>(resolve => {
            this.#release = resolve;
        });
        this.completions += 1;
    }

    release(): void {
        const r = this.#release;
        this.#release = null;
        r?.();
    }
}

// A restart-mode handler: the newest invocation wins, the previous is cancelled at its await.
export class Aimer extends SyncedScript<Entity> {
    starts = 0;
    finishes = 0;
    #release: (() => void) | null = null;

    @onEvent('aim', { concurrency: 'restart' })
    async aim(): Promise<void> {
        this.starts += 1;
        await new Promise<void>(resolve => {
            this.#release = resolve;
        });
        this.finishes += 1;
    }

    release(): void {
        const r = this.#release;
        this.#release = null;
        r?.();
    }
}

// A handler that always throws, for the error-boundary / breaker tests.
export class Faulty extends SyncedScript<Entity> {
    @onEvent('boom')
    boom(): void {
        throw new Error('handler always throws');
    }
}

// A Game-hosted ServerScript, for the load-order / @onStart / @onRequest / roster tests.
// It carries global @serverState and an @onRequest handler (legal only on a ServerScript).
export class Rules extends ServerScript {
    @serverState started = false;
    @serverState credits = 0;

    @onStart
    begin(): void {
        this.started = true;
    }

    @onRequest('grant')
    grant(ctx: Ctx): void {
        this.credits += (ctx.data.amount as number) ?? 0;
    }
}

// @onRequest on a non-ServerScript is a wire-time error (§5.9). This SyncedScript declares
// one so the wiring-rejection test can attach it and expect a throw.
export class SyncedWithRequest extends SyncedScript<Entity> {
    @onRequest('illegal')
    handle(): void {
        /* the location, not the body, is what wire time rejects */
    }
}
