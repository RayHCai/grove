// Text assets: measure with a 2D canvas, rasterize to a texture (§9.3).
//
// WHY MEASUREMENT IS SPLIT FROM UPLOAD. `CanvasTextMetrics` uses a 2D canvas, NOT WebGL, so a
// size is obtainable even while the GPU context is lost — only the upload has to queue. That is
// what lets `createTextAsset` resolve with a real size mid-loss and keeps layout from blocking on
// a context restore (§9.3, §10).
//
// The trade §9.3 accepts in exchange: world text is an asset first, so it participates uniformly
// in retention, unloading, queueing and post-loss re-upload with no special case — and `culling`
// is exact, because world text has a texture size like any other sprite.

import { CanvasTextMetrics, Text, TextStyle as PixiTextStyle } from 'pixi.js';
import type { Renderer } from 'pixi.js';
import type { Size } from '@platform/math';
import type { TextStyle } from '../renderer.js';
import { toPixiTextStyleOptions } from './text-style.js';

/**
 * Measures `text` without touching the GPU.
 *
 * Safe during a context loss, which is the whole point (§9.3).
 */
export function measureText(text: string, style: TextStyle | undefined): Size {
    const pixiStyle = new PixiTextStyle(toPixiTextStyleOptions(style));
    const metrics = CanvasTextMetrics.measureText(text, pixiStyle);
    // A resolution multiplier scales the RASTER, not the layout box, so it is deliberately not
    // applied here — a caller asking for `resolution: 2` wants a sharper texture at the same
    // world size (§9.3).
    return { width: metrics.width, height: metrics.height };
}

/**
 * Rasterizes `text` to a texture.
 *
 * Needs a live renderer, so this is the half that queues while the context is lost. `resolution`
 * is the caller's explicit answer to zoom blur: world text does not re-rasterize on zoom, so
 * sharpness is chosen deliberately rather than magically (§9.3).
 */
export function rasterizeText(
    renderer: Renderer,
    text: string,
    style: TextStyle | undefined,
): { texture: ReturnType<Renderer['generateTexture']>; size: Size } {
    // A constructed `TextStyle` rather than the raw options object: the options form widens
    // enough that TypeScript picks the bare `new Text(text)` overload instead.
    const displayText = new Text({
        text,
        style: new PixiTextStyle(toPixiTextStyleOptions(style)),
    });

    const texture = renderer.generateTexture({
        target: displayText,
        ...(style?.resolution !== undefined && { resolution: style.resolution }),
    });

    const size: Size = { width: displayText.width, height: displayText.height };
    // The Text object was scaffolding for the raster; the texture outlives it.
    displayText.destroy();
    return { texture, size };
}
