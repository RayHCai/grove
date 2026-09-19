// Player-hosted, so these replicate to their owner alone. The record is read before
// `@onPlayerJoin` and written back at the close, so a rejoin under the same id gets them.

import type { Player } from '@platform/engine';
import { ServerScript, serverState } from '@platform/engine';

export class Profile extends ServerScript<Player> {
    @serverState lifetimeLeaves = 0;
    @serverState bestRound = 0;
    /**
     * Per-session, and cleared by `Rules` at the join for that reason: it rides the same persisted
     * record, so a tab that closed just after readying would come back already readied.
     */
    @serverState ready = false;
    /** The palette seat the rules assigned, which is also this tab's own spawn point. */
    @serverState slot = 0;
}
