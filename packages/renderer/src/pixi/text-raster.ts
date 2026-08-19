// Measurement is split from upload because `CanvasTextMetrics` uses a 2D canvas rather than WebGL:
// a size is obtainable while the GPU context is lost, so `createTextAsset` resolves with a real
// size mid-loss and layout never blocks on a restore.
//
// Text is the one asset built from a string the caller supplies at runtime — a player name, a chat
// line — so length, size and raster scale are clamped here rather than trusted. Unclamped, a 2000
// character line or a `resolution` of 64 asks the GPU for a texture measured in hundreds of
// megapixels, which is a tab crash rather than a rendering bug.

import { CanvasTextMetrics, Text, TextStyle as PixiTextStyle } from 'pixi.js';
import type { Renderer } from 'pixi.js';
import type { Size } from '@platform/math';
import type { TextStyle } from '../renderer.js';
import { toPixiTextStyleOptions } from './text-style.js';

/** Characters kept from a text asset's string; the rest are dropped. */
const MAX_TEXT_LENGTH = 4096;

/** The largest raster a text asset may ask for, per axis, after `resolution`. */
const MAX_TEXT_RASTER = 4096;

/** `text` truncated to what a raster can hold. */
function clampText(text: string): string {
    return text.length <= MAX_TEXT_LENGTH ? text : text.slice(0, MAX_TEXT_LENGTH);
}

/** Measures `text` without touching the GPU, so it is safe during a context loss. */
export function measureText(text: string, style: TextStyle | undefined): Size {
    const pixiStyle = new PixiTextStyle(toPixiTextStyleOptions(style));
    const metrics = CanvasTextMetrics.measureText(clampText(text), pixiStyle);
    // `resolution` scales the raster, not the layout box: a caller asking for 2 wants a sharper
    // texture at the same world size.
    return { width: metrics.width, height: metrics.height };
}

/**
 * Rasterizes `text` to a texture.
 *
 * Needs a live renderer, so this is the half that queues while the context is lost. World text
 * does not re-rasterize on zoom, so `style.resolution` is the caller's answer to zoom blur — capped
 * so that the request cannot exceed what a GPU will allocate.
 */
export function rasterizeText(
    renderer: Renderer,
    text: string,
    style: TextStyle | undefined,
): { texture: ReturnType<Renderer['generateTexture']>; size: Size } {
    // A constructed `TextStyle` rather than raw options: the options form widens enough that
    // TypeScript picks the bare `new Text(text)` overload instead.
    const displayText = new Text({
        text: clampText(text),
        style: new PixiTextStyle(toPixiTextStyleOptions(style)),
    });

    const size: Size = { width: displayText.width, height: displayText.height };
    const resolution = rasterResolution(style?.resolution, size);

    const texture = renderer.generateTexture({ target: displayText, resolution });

    // The Text was scaffolding for the raster; the texture outlives it.
    displayText.destroy();
    return { texture, size };
}

/**
 * The raster scale actually used: the requested one, floored at a usable value and reduced until
 * neither axis exceeds {@link MAX_TEXT_RASTER}.
 */
function rasterResolution(requested: number | undefined, size: Size): number {
    const wanted =
        Number.isFinite(requested) && (requested as number) > 0 ? (requested as number) : 1;
    const longest = Math.max(size.width, size.height, 1);
    return Math.min(wanted, Math.max(MAX_TEXT_RASTER / longest, 1 / longest));
}
