// Compiled by the build: `tsc` lowers standard decorators and the test runner's transform does
// not, so tests import these from `../dist/testkit/`. Not public surface.

import type { Ctx, Player } from '@platform/core';
import { ServerScript, onPlayerJoin, onStart, serverState } from '@platform/core';

/** Player-hosted `@serverState`, which is what makes a leave owe the store a write. */
export class Wallet extends ServerScript<Player> {
    @serverState credits = 10;
}

/** The Game script every fixture project attaches: it spawns each joiner and gives a wallet. */
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
