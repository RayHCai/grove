// The contract both halves compile against, and the palette that says who spawned what.

import { describe, it, expect } from 'vitest';
import {
    AIM_BIAS,
    PLAYER_TINTS,
    decodeAim,
    encodeAim,
    markerTemplate,
    tintCss,
    tintFor,
    tintSlot,
} from '../src/scripts/globals';

describe('the aim encoding', () => {
    it('round-trips a click', () => {
        expect(decodeAim(encodeAim(123.5))).toBeCloseTo(123.5, 10);
        expect(decodeAim(encodeAim(-270))).toBeCloseTo(-270, 10);
    });

    it('keeps every legal world y clear of zero', () => {
        // A neutral axis is dropped by the client's quantizer before it has ever sent one, which
        // would silently swallow a first click on the stage's centre line.
        for (const y of [-270, -1, 0, 1, 270]) expect(encodeAim(y)).not.toBe(0);
        expect(AIM_BIAS).toBeGreaterThan(270);
    });
});

describe('the player palette', () => {
    it('gives each of the first eight players a distinct colour', () => {
        const tints = PLAYER_TINTS.map((_, i) => tintFor(i));
        expect(new Set(tints).size).toBe(PLAYER_TINTS.length);
    });

    it('wraps rather than running out', () => {
        expect(tintSlot(PLAYER_TINTS.length)).toBe(0);
        expect(tintSlot(PLAYER_TINTS.length + 3)).toBe(3);
        expect(markerTemplate(PLAYER_TINTS.length)).toBe(markerTemplate(0));
    });

    it('stays in range for an index no player index can actually be', () => {
        // `index` only ever counts up, but a wrong sign here would index the array out of bounds.
        expect(tintSlot(-1)).toBeGreaterThanOrEqual(0);
        expect(tintSlot(-1)).toBeLessThan(PLAYER_TINTS.length);
        expect(tintFor(-9)).toBeDefined();
    });

    it('renders the same colour the sprite is tinted with', () => {
        expect(tintCss(0)).toBe('#52b788');
        expect(tintCss(1)).toBe('#64b5f6');
        // Six digits always, so a dark channel cannot shorten it into a different colour.
        for (let i = 0; i < PLAYER_TINTS.length; i++) expect(tintCss(i)).toMatch(/^#[0-9a-f]{6}$/);
    });
});
