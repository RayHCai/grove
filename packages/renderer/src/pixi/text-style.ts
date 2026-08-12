// Our `TextStyle` -> Pixi's, with the clamps that keep a caller-supplied style from reaching the
// GPU as an unbounded raster or a colour pixi refuses.
//
// Conditional spread throughout, because `exactOptionalPropertyTypes` makes `{fontSize: undefined}`
// a compile error: an absent field has to be an absent key.

import type { TextStyle as PixiTextStyle } from 'pixi.js';
import type { TextStyle } from '../renderer.js';

/** Pixi's default when a style omits `font`. */
const DEFAULT_FAMILY = 'Arial';

/** Pixi's default when a style omits `size`. */
const DEFAULT_SIZE = 26;

/** Largest font size a style may ask for, in px. */
const MAX_SIZE = 512;

/** Largest wrap width a style may ask for, in px — the same bound a raster is capped to. */
const MAX_WRAP = 4096;

/**
 * A `0xRRGGBB` colour, or the fallback.
 *
 * Pixi throws on a value outside the 24-bit range, and an ARGB literal — a plausible caller slip,
 * since the field is just a `number` — would otherwise take down whatever is rasterizing.
 */
function color(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.trunc(value), 0), 0xffffff);
}

/** A positive, finite dimension no larger than `max`. */
function dimension(value: number, max: number): number {
    if (!Number.isFinite(value) || value <= 0) return 1;
    return Math.min(value, max);
}

/**
 * The options object, separately, because `CanvasTextMetrics.measureText` wants a style and the
 * raster path wants to reuse the same construction.
 */
// `NonNullable` because Pixi's constructor parameter is optional, so the raw
// `ConstructorParameters[0]` includes `undefined` — which this function never returns.
export function toPixiTextStyleOptions(
    style: TextStyle | undefined,
): NonNullable<ConstructorParameters<typeof PixiTextStyle>[0]> {
    if (style === undefined) {
        return { fontFamily: DEFAULT_FAMILY, fontSize: DEFAULT_SIZE };
    }

    return {
        fontFamily: style.font ?? DEFAULT_FAMILY,
        fontSize: style.size === undefined ? DEFAULT_SIZE : dimension(style.size, MAX_SIZE),
        // `color` is 0xRRGGBB; Pixi calls the same concept `fill`.
        ...(style.color !== undefined && { fill: color(style.color, 0xffffff) }),
        ...(style.align !== undefined && { align: style.align }),
        ...(style.weight !== undefined && { fontWeight: style.weight }),
        ...(style.italic === true && { fontStyle: 'italic' as const }),
        ...(style.stroke !== undefined && {
            stroke: {
                color: color(style.stroke.color, 0),
                width: dimension(style.stroke.width, MAX_SIZE),
            },
        }),
        // Pixi needs word-wrap switched on explicitly; a wrap width alone does nothing.
        ...(style.wrapWidth !== undefined && {
            wordWrap: true,
            wordWrapWidth: dimension(style.wrapWidth, MAX_WRAP),
        }),
        ...(style.lineHeight !== undefined && {
            lineHeight: dimension(style.lineHeight, MAX_SIZE),
        }),
    };
}
