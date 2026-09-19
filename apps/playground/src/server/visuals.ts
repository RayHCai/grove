// A `RenderManifest` because it is announced MID-SESSION through `declareVisuals` — the path a
// connected peer's `manifest` envelope and a later joiner's welcome have to agree about.

import type { RenderManifest } from '@platform/protocol';
import { assetId, templateId } from '@platform/project';
import { CROWN_TEMPLATE, MARKER_ASSET } from '../scripts/globals.js';

/**
 * The winner's crown: a `group` visual with two sprites beneath it, as one `createSubtree`.
 * Every size is HERE — only position and visibility inherit, so a `setScale` on the pivot is inert.
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
