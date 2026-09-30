import { describe, expect, it } from 'vitest';
import { fonts, readThemeColors } from '../src/tokens.js';

describe('tokens', () => {
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
