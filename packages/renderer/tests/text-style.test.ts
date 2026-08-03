// Our `TextStyle` -> Pixi's. Runs in Node: building a TextStyle needs no WebGL, only the
// `exactOptionalPropertyTypes` discipline the module exists to keep.

import { describe, it, expect } from 'vitest';
import { toPixiTextStyleOptions } from '../src/pixi/text-style.js';

describe('toPixiTextStyleOptions', () => {
    it('supplies both defaults for an absent style', () => {
        const options = toPixiTextStyleOptions(undefined);
        expect(options).toEqual({ fontFamily: 'Arial', fontSize: 26 });
    });

    it('maps every field it is given', () => {
        const options = toPixiTextStyleOptions({
            font: 'Chalk',
            size: 18,
            color: 0xff8800,
            align: 'center',
            weight: 'bold',
            italic: true,
            stroke: { color: 0x000000, width: 2 },
            wrapWidth: 240,
            lineHeight: 22,
        });

        expect(options).toEqual({
            fontFamily: 'Chalk',
            fontSize: 18,
            fill: 0xff8800,
            align: 'center',
            fontWeight: 'bold',
            fontStyle: 'italic',
            stroke: { color: 0x000000, width: 2 },
            wordWrap: true,
            wordWrapWidth: 240,
            lineHeight: 22,
        });
    });

    it('OMITS absent keys rather than setting them undefined', () => {
        const options = toPixiTextStyleOptions({ size: 12 });

        // The point of the conditional spread: `exactOptionalPropertyTypes` makes an explicit
        // `undefined` a compile error, and Pixi would treat a present-but-undefined key
        // differently from an absent one.
        expect(Object.hasOwn(options, 'fill')).toBe(false);
        expect(Object.hasOwn(options, 'align')).toBe(false);
        expect(Object.hasOwn(options, 'stroke')).toBe(false);
        expect(Object.hasOwn(options, 'wordWrap')).toBe(false);
        expect(Object.hasOwn(options, 'lineHeight')).toBe(false);
        expect(Object.hasOwn(options, 'fontStyle')).toBe(false);
    });

    it('turns word wrap ON alongside a wrap width', () => {
        // A wrapWidth with no wordWrap flag does nothing in Pixi, so the two must travel
        // together.
        const options = toPixiTextStyleOptions({ wrapWidth: 100 });
        expect(options).toMatchObject({ wordWrap: true, wordWrapWidth: 100 });
    });

    it('omits fontStyle when italic is explicitly false', () => {
        const options = toPixiTextStyleOptions({ italic: false });
        expect(Object.hasOwn(options, 'fontStyle')).toBe(false);
    });

    it('does not forward resolution — that scales the raster, not the layout box', () => {
        const options = toPixiTextStyleOptions({ resolution: 3 });
        // §9.3: `resolution` is the caller's answer to zoom blur and belongs to the raster call.
        expect(Object.hasOwn(options, 'resolution')).toBe(false);
    });

    it('keeps a zero color rather than falling back to a default', () => {
        // Black is 0, so a truthiness check here would silently drop it.
        const options = toPixiTextStyleOptions({ color: 0x000000 });
        expect(options).toMatchObject({ fill: 0 });
    });
});
