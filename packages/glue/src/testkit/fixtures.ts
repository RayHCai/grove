// Decorator-bearing fixtures compiled by the build: `tsc` lowers standard decorators and the test
// runner's transform does not, so the tests import the compiled classes from `../dist/testkit/` and
// carry no decorator syntax themselves.
//
// Not public surface — exported only so this package's suite can reach it, and the one place here
// that touches core's decorated surface: `src/` proper drives core as values and declares no script.

import type { Ctx, Player } from '@platform/core';
import { ServerScript, onPlayerJoin, onStart, serverState } from '@platform/core';

/** Player-hosted `@serverState`, which is what makes a leave owe the store a write. */
export class Wallet extends ServerScript<Player> {
    @serverState credits = 10;
}

/** The Game script every fixture project attaches: it spawns each joiner and gives them a wallet. */
export class Bank extends ServerScript {
    @serverState round = 1;
    started = false;

    @onStart
    begin(): void {
        this.started = true;
    }

    @onPlayerJoin
    join(ctx: Ctx): void {
        const player = ctx.player as Player | undefined;
        if (!player) return;
        player.addScript(Wallet);
        player.spawn();
    }
}
