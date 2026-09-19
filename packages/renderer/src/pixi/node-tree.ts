// `xform` carries only what inherits, `art` only what does not, and a child xform is a SIBLING of
// `art` — nesting children under `art` silently restores full inheritance.
// `sortableChildren` is load-bearing: Pixi's stable sort draws a default-layer child over art.

import { Container, Sprite, Text, TextStyle as PixiTextStyle } from 'pixi.js';
import type { Texture } from 'pixi.js';
import type { NodeKind } from '../node-store.js';
import type { TextStyle } from '../renderer.js';
import { toPixiTextStyleOptions } from './text-style.js';

/** The display-object pair for one node. `art` is absent for a group. */
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
    xform.sortableChildren = true;

    // A group is a positional pivot: its rotation, scale, alpha and tint stay queryable but inert.
    if (kind === 'group') return { xform, art: null };

    const art: Sprite | Text =
        kind === 'text'
            ? new Text({ text, style: new PixiTextStyle(toPixiTextStyleOptions(style)) })
            : new Sprite(texture);

    // Inserted first and pinned to zIndex 0, so a default-layer child sorts in front of it.
    art.zIndex = 0;
    xform.addChild(art);
    return { xform, art };
}

/** Attaches a node's xform under its parent's, or a surface root; `zIndex` is its `layer`. */
export function attachXform(objects: NodeObjects, parent: Container, layer: number): void {
    objects.xform.zIndex = layer;
    parent.addChild(objects.xform);
}

/** Moves a node's xform, and the subtree beneath it, to a new parent. */
export function reparentXform(objects: NodeObjects, parent: Container): void {
    parent.addChild(objects.xform);
}

/** Swaps a sprite's texture. Ignored for a group or a text node. */
export function setArtTexture(objects: NodeObjects, texture: Texture): void {
    const art = objects.art;
    if (art instanceof Sprite) art.texture = texture;
}

/** Updates a UI text node's string. Ignored for anything else, since world text is an asset. */
export function setArtText(objects: NodeObjects, text: string): void {
    const art = objects.art;
    if (art instanceof Text) art.text = text;
}

/** Toggles a node's art only, never its xform, so culling a parent cannot hide its children. */
export function setArtRenderable(objects: NodeObjects, renderable: boolean): void {
    if (objects.art !== null) objects.art.renderable = renderable;
}

/** Destroys the pair and, since descendants are real children of the xform, cascades to them. */
export function destroyNodeObjects(objects: NodeObjects): void {
    objects.xform.destroy({ children: true });
}
