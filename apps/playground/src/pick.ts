// Screen point to entity handle — the half of a pointer hit no package performs.
//
// `client.pointer(edge, local)` takes the LOCAL handle the render layer holds and maps it to a
// netId itself, so the layer that hit-tests never learns there is a network. What it does not do is
// decide WHICH entity was hit: a cursor position means nothing without the camera that drew it, so
// resolving one is the host's, and the authority is told the answer rather than recomputing it.

import type { EntityId, Runtime } from '@platform/core';
import { SEND_RATE } from './project';
import { LEAF_HALF, LEAF_SCALE, LEAF_SPEED, LEAF_TAG } from './shared';

/**
 * How far behind its simulated pose a leaf is DRAWN, in world px.
 *
 * The render bridge buffers everything it does not predict by one send interval and interpolates
 * between the two poses either side of that moment — which is what keeps a leaf smooth at 20
 * broadcasts a second. A leaf only ever travels right, at a constant speed, so the sprite on screen
 * is exactly this far left of what `rt.transforms` says. Hit-testing the simulated pose would put
 * the click box a whole leaf-width off the art at 240 px/s.
 */
const DRAW_LAG = LEAF_SPEED / SEND_RATE;

/**
 * The topmost live leaf whose drawn box contains `(x, y)`, or `undefined`.
 *
 * Topmost by layer, then by whichever is found last: two leaves overlapping is ordinary, and
 * picking the one drawn underneath would read as a click that missed. The box is the leaf's own
 * half-extent rather than the renderer's bounds, so the browser and the authority agree about what
 * "on a leaf" means even though only one of them holds a collider.
 */
export function pickLeaf(rt: Runtime, x: number, y: number): EntityId | undefined {
    let best: EntityId | undefined;
    let bestLayer = -Infinity;

    for (const id of rt.entities.liveIds()) {
        if (!rt.tags.has(id, LEAF_TAG)) continue;
        // The leaf's own scale, because a ripened one draws — and is harvested — larger.
        const half = LEAF_HALF * (rt.transforms.scale(id) / LEAF_SCALE);
        if (Math.abs(rt.transforms.posX(id) - DRAW_LAG - x) > half) continue;
        if (Math.abs(rt.transforms.posY(id) - y) > half) continue;

        const layer = rt.transforms.layer(id);
        if (best !== undefined && layer < bestLayer) continue;
        best = id;
        bestLayer = layer;
    }
    return best;
}
