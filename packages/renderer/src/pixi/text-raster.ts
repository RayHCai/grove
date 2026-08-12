// Measurement is split from upload because `CanvasTextMetrics` uses a 2D canvas rather than WebGL:
// a size is obtainable while the GPU context is lost, so `createTextAsset` resolves with a real
// size mid-loss and layout never blocks on a restore.

import { CanvasTextMetrics, Text, TextStyle as PixiTextStyle } from 'pixi.js';
import type { Renderer } from 'pixi.js';
import type { Size } from '@platform/math';
import type { TextStyle } from '../renderer.js';
import { toPixiTextStyleOptions } from './text-style.js';

/** Measures `text` without touching the GPU, so it is safe during a context loss. */
export function measureText(text: string, style: TextStyle | undefined): Size {
    const pixiStyle = new PixiTextStyle(toPixiTextStyleOptions(style));
    const metrics = CanvasTextMetrics.measureText(text, pixiStyle);
    // `resolution` scales the raster, not the layout box: a caller asking for 2 wants a sharper
    // texture at the same world size.
    return { width: metrics.width, height: metrics.height };
}

/**
 * Rasterizes `text` to a texture.
 *
 * Needs a live renderer, so this is the half that queues while the context is lost. World text
 * does not re-rasterize on zoom, so `style.resolution` is the caller's answer to zoom blur.
 */
export function rasterizeText(
    renderer: Renderer,
    text: string,
    style: TextStyle | undefined,
): { texture: ReturnType<Renderer['generateTexture']>; size: Size } {
    // A constructed `TextStyle` rather than raw options: the options form widens enough that
    // TypeScript picks the bare `new Text(text)` overload instead.
    const displayText = new Text({
        text,
        style: new PixiTextStyle(toPixiTextStyleOptions(style)),
    });

    const texture = renderer.generateTexture({
        target: displayText,
        ...(style?.resolution !== undefined && { resolution: style.resolution }),
    });

    const size: Size = { width: displayText.width, height: displayText.height };
    // The Text was scaffolding for the raster; the texture outlives it.
    displayText.destroy();
    return { texture, size };
}
