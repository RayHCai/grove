// Art for a template the boot manifest deliberately does not carry.
//
// It is a `RenderManifest` rather than a project entry because it is announced MID-SESSION, through
// `declareVisuals`, the first time a round is won — which is the path a connected peer's `manifest`
// envelope and a later joiner's welcome have to agree about.

import type { RenderManifest } from '@platform/protocol';
import { assetId, templateId } from '@platform/project';
import { CROWN_TEMPLATE, MARKER_ASSET } from '../scripts/globals.js';

/**
 * The winner's crown: a `group` visual with two sprites beneath it.
 *
 * The whole subtree arrives as one `createSubtree` rather than as entities the game would have to
 * parent by hand — the children are the TEMPLATE's art, and nothing simulates them, which is why
 * they are the one visual that may carry an offset. It names no new asset: `marker.png` is already
 * resident, and a tint multiplies against white.
 *
 * Every size is HERE and not on the spawned entity. Only position and visibility inherit, so a
 * `setScale` on the pivot the game spawns would resize nothing — `marker.png` is 8x8, which makes
 * these 40 and 20 world px.
 */
export const CROWN_VISUALS: RenderManifest = {
    assets: [],
    templates: [
        {
            template: templateId(CROWN_TEMPLATE),
            kind: 'group',
            children: [
                { kind: 'sprite', texture: assetId(MARKER_ASSET), tint: 0xffd54f, scale: 5 },
                {
                    kind: 'sprite',
                    texture: assetId(MARKER_ASSET),
                    tint: 0xfff8e1,
                    scale: 2.5,
                    offsetY: 16,
                },
            ],
        },
    ],
};
