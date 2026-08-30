// Attached to every Player at the join, and the only thing here that outlives a session.
//
// The server reads this player's saved record before `@onPlayerJoin` runs and writes it back when
// the socket closes, keyed by the identity the host supplied — so these fields come back on a
// rejoin under the same id with nothing else to arrange. Player-hosted, so they replicate to their
// owner and to nobody else, which is the scope a personal total wants.

import type { Player } from '@platform/engine';
import { ServerScript, serverState } from '@platform/engine';

export class Profile extends ServerScript<Player> {
    @serverState lifetimeLeaves = 0;
    @serverState bestRound = 0;
    /**
     * Per-session, and cleared by `Rules` at the join for that reason.
     *
     * It rides the same record `lifetimeLeaves` does, and that record is persisted — so a tab that
     * closed the moment after readying would come back already readied, and the next press would
     * un-ready them rather than start a round.
     */
    @serverState ready = false;
    /** The palette seat the rules assigned, which is also this tab's own spawn point. */
    @serverState slot = 0;
}
