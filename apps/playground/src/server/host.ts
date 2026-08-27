// How this world is HOSTED, separate from what it is — so a test can boot the same project over a
// loopback pair that `main.ts` boots over a socket.
//
// `createServer` is the composition root: it validates the authored file, resolves each attachment's
// class through the registry, builds the templates and the placed world, and only then is the server
// willing to accept anything. That order is the whole reason it exists — a connection admitted
// before the world is built joins a game that is not there yet, and a joiner's snapshot is the one
// baseline no later delta repairs.

import type { BreakerTrip, KVStore } from '@platform/core';
import { createServer } from '@platform/engine/host';
import type { RenderManifest } from '@platform/protocol';
import type { GameServer } from '@platform/server';
import { PROJECT } from '../project.js';
import { CROWN_TEMPLATE, MARKER_ASSET } from '../shared.js';
import { onCrownNeeded, resetWorld } from './game.js';
import { SERVER_SCRIPTS } from './scripts.js';

export { SEND_RATE, SIM_RATE } from '../project.js';

/**
 * The winner's crown: art for a template the boot manifest deliberately does not carry.
 *
 * A `group` visual with two sprites beneath it, so the whole subtree arrives as one `createSubtree`
 * rather than as entities the game would have to parent by hand — the children are the TEMPLATE's
 * art, and nothing simulates them, which is why they are the one visual that may carry an offset.
 * It names no new asset: `marker.png` is already resident, and a tint multiplies against white.
 *
 * Every size is HERE and not on the spawned entity. Only position and visibility inherit, so a
 * `setScale` on the pivot the game spawns would resize nothing — `marker.png` is 8x8, which makes
 * these 40 and 20 world px.
 */
export const CROWN_VISUALS: RenderManifest = {
    assets: [],
    templates: [
        {
            template: CROWN_TEMPLATE,
            kind: 'group',
            children: [
                { kind: 'sprite', texture: MARKER_ASSET, tint: 0xffd54f, scale: 5 },
                { kind: 'sprite', texture: MARKER_ASSET, tint: 0xfff8e1, scale: 2.5, offsetY: 16 },
            ],
        },
    ],
};

export interface HostOptions {
    /** Where `@serverState` outlives a session. Omitted, core's memory store dies with the process. */
    kv?: KVStore;
    /** The loopback pair's `deliver`; omitted networked, where each socket delivers itself. */
    deliver?: () => void;
    /** The dev channel for a handler the breaker gave up on. Not an envelope, deliberately. */
    onBreakerTrip?: (trip: BreakerTrip) => void;
}

/**
 * Boots the authority for this project. It accepts nothing and starts no clock.
 *
 * No transport is passed even though `createServer` takes one: it would call `accept(transport)`
 * with no player id, and the id is what makes `@serverState` survive a rejoin — so every caller
 * here calls `accept(transport, playerId)` itself, per socket.
 */
export function createGameServer(opts: HostOptions = {}): GameServer {
    // A second server in one process must not inherit the first's captured Game.
    resetWorld();
    const server = createServer(PROJECT, undefined, {
        scripts: SERVER_SCRIPTS,
        ...(opts.kv === undefined ? {} : { kv: opts.kv }),
        ...(opts.deliver === undefined ? {} : { deliver: opts.deliver }),
        ...(opts.onBreakerTrip === undefined ? {} : { onBreakerTrip: opts.onBreakerTrip }),
    });
    // After construction, because the Game's `@onStart` has already run by now and the declaration
    // is only ever needed later — the first time a round is actually won.
    onCrownNeeded(() => server.declareVisuals(CROWN_VISUALS));
    return server;
}
