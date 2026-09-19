import { describe, expect, it } from 'vitest';
import { duration, fonts, pixel, readThemeColors, space, vars } from '../src/tokens.js';

describe('tokens', () => {
    it('names the custom properties instead of repeating their values', () => {
        expect(vars.bg).toBe('var(--pg-bg)');
        expect(vars.surface2).toBe('var(--pg-surface-2)');
        expect(vars.borderStrong).toBe('var(--pg-border-strong)');
        expect(vars.accentSoft).toBe('var(--pg-accent-soft)');
        expect(vars.warmInk).toBe('var(--pg-warm-ink)');
        expect(vars.codeLine).toBe('var(--pg-code-line)');
        expect(vars.shadowMd).toBe('var(--pg-shadow-md)');
        expect(vars.notch).toBe('var(--pg-notch)');
        expect(vars.edge).toBe('var(--pg-edge)');
        expect(vars.fontMono).toBe('var(--pg-font-mono)');
        expect(vars.ease).toBe('var(--pg-ease)');
        expect(vars.durSlow).toBe('var(--pg-dur-slow)');
    });

    it('carries the scalars of the spacing, construction and motion scales', () => {
        expect(space[1]).toBe(4);
        expect(space[8]).toBe(80);
        expect(pixel.borderWidth).toBe(3);
        expect(pixel.lift).toBe(4);
        expect(duration.fast).toBe(120);
        expect(duration.base).toBe(180);
        expect(duration.slow).toBe(260);
    });

    it('carries the three font stacks', () => {
        expect(fonts.ui.startsWith("'VT323'")).toBe(true);
        expect(fonts.brand.startsWith("'Press Start 2P'")).toBe(true);
        expect(fonts.mono.startsWith('ui-monospace')).toBe(true);
        expect(fonts.mono.endsWith('monospace')).toBe(true);
    });
});

describe('readThemeColors', () => {
    it('follows data-theme on the root element', () => {
        const style = document.createElement('style');
        style.textContent =
            ":root{--pg-bg: #f4ead2 ;--pg-code-line:#2e2a240d}:root[data-theme='dark']{--pg-bg:#1a1714}";
        document.head.append(style);

        expect(readThemeColors().bg).toBe('#f4ead2');
        expect(readThemeColors()['code-line']).toBe('#2e2a240d');

        document.documentElement.setAttribute('data-theme', 'dark');
        expect(readThemeColors().bg).toBe('#1a1714');

        style.remove();
    });
});
