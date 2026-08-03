// Our `TextStyle` -> Pixi's. A mapping file, no policy.
//
// Built with conditional spread throughout: `exactOptionalPropertyTypes` makes
// `{fontSize: undefined}` a compile error, so an absent field must be an ABSENT KEY rather than
// an undefined value. That is why this reads as a pile of spreads instead of an object literal.

import { TextStyle as PixiTextStyle } from 'pixi.js';
import type { TextStyle } from '../renderer.js';

/** Pixi's default when a style omits `font`. */
const DEFAULT_FAMILY = 'Arial';

/** Pixi's default when a style omits `size`. */
const DEFAULT_SIZE = 26;

/** Builds the Pixi style for one of our `TextStyle`s. */
export function toPixiTextStyle(style: TextStyle | undefined): PixiTextStyle {
    return new PixiTextStyle(toPixiTextStyleOptions(style));
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
        fontSize: style.size ?? DEFAULT_SIZE,
        // `color` is 0xRRGGBB; Pixi calls the same concept `fill`.
        ...(style.color !== undefined && { fill: style.color }),
        ...(style.align !== undefined && { align: style.align }),
        ...(style.weight !== undefined && { fontWeight: style.weight }),
        ...(style.italic === true && { fontStyle: 'italic' as const }),
        ...(style.stroke !== undefined && {
            stroke: { color: style.stroke.color, width: style.stroke.width },
        }),
        // Pixi needs word-wrap switched on explicitly; a wrap width alone does nothing.
        ...(style.wrapWidth !== undefined && {
            wordWrap: true,
            wordWrapWidth: style.wrapWidth,
        }),
        ...(style.lineHeight !== undefined && { lineHeight: style.lineHeight }),
    };
}
