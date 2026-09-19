// Player-hosted, so every field is scoped to its own player. `@serverState` is also the
// persistence channel, which makes `collected` a total across rejoins.

import type { Player } from '@platform/engine';
import { ServerScript, serverState } from '@platform/engine';

export class Profile extends ServerScript<Player> {
    /** Checkpointed against this player's record and read back under the same identity. */
    @serverState lifetime = 0;
    @serverState best = 0;

    /** This session only, and reset at every join — a seat a departed player left is reused. */
    @serverState seat = 0;
    @serverState taken = 0;
}
