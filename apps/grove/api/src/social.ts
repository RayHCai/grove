import type { PlayerId } from '@grove/api-contract';

/** One entry in a viewer's friend list, as the social seam reports it. */
export interface Friend {
    playerId: PlayerId;
    displayName: string;
    online: boolean;
}

/**
 * Friends, presence and the block list.
 *
 * A seam rather than a store, because this repo names no social graph: which service holds one is
 * a decision the routes must not encode, and both reads are on the join path.
 */
export interface Social {
    /** Who this viewer has blocked, loaded once per request and read by every route in the scope. */
    blockedBy(viewer: PlayerId): Promise<ReadonlySet<PlayerId>>;
    friendsOf(viewer: PlayerId, blockedBy: ReadonlySet<PlayerId>): Promise<Friend[]>;
}

/**
 * The social seam with nothing behind it: nobody is blocked and nobody is a friend.
 *
 * Empty rather than a refusal, unlike the other unattached seams — a player with no social graph
 * behind them still has a working session, and a 501 here would take the whole signed-in shell
 * down over a list that is allowed to be empty.
 */
export const unattachedSocial: Social = {
    blockedBy: async () => new Set(),
    friendsOf: async () => [],
};
