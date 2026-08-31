// Attached to every Player at the join, and the only thing here that outlives a session.
//
// The server reads this player's saved record before `@onPlayerJoin` runs and writes it back when
// the socket closes, so these come back on a rejoin under the same id with nothing else to arrange.
// Player-hosted, so they replicate to their owner and to nobody else.

import type { Player } from '@platform/engine';
import { ServerScript, serverState } from '@platform/engine';

export class Profile extends ServerScript<Player> {
    @serverState lifetimeLeaves = 0;
    @serverState bestRound = 0;
    /**
     * Per-session, and cleared by `Rules` at the join for that reason.
     *
     * It rides the same persisted record `lifetimeLeaves` does, so a tab that closed just after
     * readying would come back already readied and the next press would un-ready it.
     */
    @serverState ready = false;
    /** The palette seat the rules assigned, which is also this tab's own spawn point. */
    @serverState slot = 0;
}
