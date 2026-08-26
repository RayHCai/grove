// What this world is, separate from how it is hosted — so a test can boot the same game over a
// loopback pair that `main.ts` boots over a socket.

import { scriptId, templateId } from '@platform/project';
import type { RenderManifest } from '@platform/protocol';
import type { ServerConfig } from '@platform/server';
import {
    AVATAR_TEMPLATE,
    LEAF_ASSET,
    LEAF_PIXELS,
    LEAF_TEMPLATE,
    LEAF_URL,
    MARKER_ASSET,
    MARKER_PIXELS,
    MARKER_URL,
    PLAYER_TINTS,
    PROJECT_HASH,
    PROJECT_ID,
    SCRIPT_RUNNER,
    WORLD,
    markerTemplate,
} from '../shared.js';
import { Rules } from './game.js';
import { SERVER_SCRIPTS } from './scripts.js';

/** Ticks per simulated second. */
export const SIM_RATE = 60;

/**
 * Broadcasts per second — the package default, and the rate the client interpolates over.
 *
 * A leaf is moved by a server script, so nothing local predicts it; the client draws it one send
 * interval behind and walks between the two poses either side of that moment. Raising this to match
 * `SIM_RATE` buys nothing but `1 + connections` encodes per tick instead of per third tick.
 */
export const SEND_RATE = 20;

/** Tabs, not people — a browser refresh is a new player, since nothing here reconnects. */
export const MAX_PLAYERS = 16;

/**
 * The art, keyed by name rather than shipped.
 *
 * The url is fetched by the browser, not by the server, and the client admits only `http:`,
 * `https:` and relative paths — so this resolves against the origin that served the page.
 *
 * One badge template per player slot, differing only in tint: that is what lets a leaf carry the
 * colour of whoever spawned it, since a template is the only per-entity thing colour can ride on.
 */
export const VISUALS: RenderManifest = {
    assets: [
        { key: LEAF_ASSET, kind: 'texture', url: LEAF_URL, meta: LEAF_PIXELS },
        { key: MARKER_ASSET, kind: 'texture', url: MARKER_URL, meta: MARKER_PIXELS },
    ],
    templates: [
        { template: LEAF_TEMPLATE, kind: 'sprite', texture: LEAF_ASSET },
        { template: AVATAR_TEMPLATE, kind: 'sprite', texture: MARKER_ASSET },
        ...PLAYER_TINTS.map((tint, slot) => ({
            template: markerTemplate(slot),
            kind: 'sprite' as const,
            texture: MARKER_ASSET,
            tint,
        })),
    ],
};

export function serverConfig(): ServerConfig {
    return {
        simRate: SIM_RATE,
        sendRate: SEND_RATE,
        maxPlayers: MAX_PLAYERS,
        bounds: WORLD,
        visuals: VISUALS,
        // What `player.spawn()` mints. `Runner` rides the template rather than an `addScript` in the
        // join handler, so the avatar is running it before that handler returns — and the resulting
        // `attach` op is what tells the browser to attach its own copy and predict.
        templates: [
            {
                id: templateId(AVATAR_TEMPLATE),
                scripts: [
                    {
                        script: scriptId(SCRIPT_RUNNER),
                        klass: SERVER_SCRIPTS.resolve(scriptId(SCRIPT_RUNNER))!,
                    },
                ],
                children: [],
            },
        ],
        entities: [],
        scripts: SERVER_SCRIPTS,
        gameScripts: [Rules],
        project: {
            projectId: PROJECT_ID,
            projectHash: PROJECT_HASH,
            // No bundle: Vite compiles the synced scripts into the page's own bundle, so there is
            // nothing for the client to fetch separately and nothing to hash.
            bundleHash: '',
            bundleUrl: '',
        },
    };
}
