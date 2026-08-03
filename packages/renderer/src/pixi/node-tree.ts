// Two display objects per node — the shape that ENFORCES §5 (§6.2).
//
//   xform  (Container)   position = (local.x, -local.y)
//                        visible  = local.visible
//                        sortableChildren = true
//     ├─ art  (Sprite | Text)          zIndex = 0, INSERTED FIRST
//     │        scale, rotation = -deg * DEG2RAD, alpha, tint, anchor
//     └─ child xform, child xform, …   zIndex = child.layer
//
// `xform` carries only what INHERITS; `art` carries only what does NOT. A child xform is a
// SIBLING of `art`, so it is structurally incapable of picking up the parent's scale, rotation,
// alpha or tint — §5's rule is enforced by tree shape rather than by per-frame bookkeeping, and
// there is nothing to get wrong in `flush`. Nesting children under `art` would silently
// reintroduce full inheritance and is the single most damaging change anyone could make here.
//
// `sortableChildren` on `xform` is load-bearing: `xform.children` is `[art, ...children]`, and
// that is the list needing order. `art.zIndex = 0` inserted first; child `zIndex = layer`. Pixi's
// sort is stable, so ties break by insertion and a child with the DEFAULT layer draws in FRONT of
// its parent's art — a hat over a head. A negative `layer` puts it behind.

import { Container, Sprite, Text } from 'pixi.js';
import type { Texture } from 'pixi.js';
import type { NodeKind } from '../node-store.js';
import type { TextStyle } from '../renderer.js';
import { toPixiTextStyleOptions } from './text-style.js';
import { TextStyle as PixiTextStyle } from 'pixi.js';

/** The display-object pair for one node. `art` is absent for a group (§6.2). */
export interface NodeObjects {
    xform: Container;
    art: Sprite | Text | null;
}

/** Creates the pair for a node. A group gets an art-less pivot. */
export function createNodeObjects(
    kind: NodeKind,
    texture: Texture,
    text: string,
    style: TextStyle | undefined,
): NodeObjects {
    const xform = new Container();
    // The list that needs ordering is [art, ...children] — see the file header.
    xform.sortableChildren = true;

    if (kind === 'group') {
        // A group is a positional pivot and nothing more: its own rotation, scale, alpha and
        // tint are stored and queryable but never drawn and never inherited (§6.2).
        return { xform, art: null };
    }

    const art: Sprite | Text =
        kind === 'text'
            ? new Text({ text, style: new PixiTextStyle(toPixiTextStyleOptions(style)) })
            : new Sprite(texture);

    // Inserted FIRST and pinned to zIndex 0, so a default-layer child sorts in front of it.
    art.zIndex = 0;
    xform.addChild(art);
    return { xform, art };
}

/**
 * Attaches a node's xform under a parent's xform, or under a surface root when it has no parent.
 *
 * `zIndex` is the node's `layer`: the surface-wide ordinal for a root, sibling order once
 * parented — a child cannot escape its parent's layer, which is what a hierarchy means (§11.1).
 */
export function attachXform(objects: NodeObjects, parent: Container, layer: number): void {
    objects.xform.zIndex = layer;
    parent.addChild(objects.xform);
}

/**
 * Moves a node's xform to a new parent.
 *
 * `addChild` removes it from its previous parent, so the subtree beneath it travels along
 * untouched — the children are children of the XFORM, not of the art.
 */
export function reparentXform(objects: NodeObjects, parent: Container): void {
    parent.addChild(objects.xform);
}

/** Swaps a sprite's texture. Ignored for a group or a text node. */
export function setArtTexture(objects: NodeObjects, texture: Texture): void {
    const art = objects.art;
    if (art instanceof Sprite) art.texture = texture;
}

/** Updates a UI text node's string. Ignored for anything else (§9.3 — world text is an asset). */
export function setArtText(objects: NodeObjects, text: string): void {
    const art = objects.art;
    if (art instanceof Text) art.text = text;
}

/**
 * Toggles whether a node's ART draws.
 *
 * `renderable` on **`art` only** — never on `xform`. Children are siblings of `art`, so culling a
 * parent cannot hide them, which is another consequence of this file's tree shape (§8).
 */
export function setArtRenderable(objects: NodeObjects, renderable: boolean): void {
    if (objects.art !== null) objects.art.renderable = renderable;
}

/**
 * Destroys the pair, and with it every descendant xform.
 *
 * `{children: true}` is what makes the destroy CASCADE match `Entity.destroy()` (§11.1): the
 * descendants are real children of this xform.
 */
export function destroyNodeObjects(objects: NodeObjects): void {
    objects.xform.destroy({ children: true });
}
