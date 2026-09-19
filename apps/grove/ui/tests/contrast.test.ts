import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const tokens = readFileSync(resolve('src/styles/tokens.css'), 'utf8');

function themeBlock(selector: string): string {
    const start = tokens.indexOf(`${selector} {`);
    const end = tokens.indexOf('\n}', start);
    return tokens.slice(start, end);
}

function hex(block: string, name: string): string {
    const match = new RegExp(`--pg-${name}:\\s*(#(?:[0-9a-f]{8}|[0-9a-f]{6}))\\b`, 'i').exec(block);
    if (match?.[1] === undefined) throw new Error(`--pg-${name} is not a hex colour in ${block}`);
    return match[1].toLowerCase();
}

function channel(colour: string, offset: number): number {
    return Number.parseInt(colour.slice(offset, offset + 2), 16);
}

/** Source-over blend of a `#rrggbbaa` foreground onto an opaque `#rrggbb` background. */
function composite(foreground: string, background: string): string {
    if (foreground.length !== 9) throw new Error(`${foreground} carries no alpha to composite`);
    const alpha = channel(foreground, 7) / 255;
    const mixed = [1, 3, 5].map((offset) => {
        const value =
            channel(foreground, offset) * alpha + channel(background, offset) * (1 - alpha);
        return Math.round(value).toString(16).padStart(2, '0');
    });
    return `#${mixed.join('')}`;
}

function luminance(colour: string): number {
    const linear = (offset: number): number => {
        const value = channel(colour, offset) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(1) + 0.7152 * linear(3) + 0.0722 * linear(5);
}

function contrast(foreground: string, background: string): number {
    if (foreground.length !== 7 || background.length !== 7) {
        throw new Error(`contrast() takes opaque colours, got ${foreground} on ${background}`);
    }
    const a = luminance(foreground);
    const b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const TEXT_PAIRS: ReadonlyArray<readonly [string, string]> = [
    ['ink', 'surface'],
    ['ink', 'accent-soft'],
    ['ink', 'warm-soft'],
    ['accent-ink', 'accent'],
    ['ink-muted', 'surface-2'],
    ['placeholder', 'surface'],
    ['warm-ink', 'surface'],
    ['warm-ink', 'warm-soft'],
];

const OUTLINE_PAIRS: ReadonlyArray<readonly [string, string]> = [
    ['border-strong', 'surface'],
    ['border-strong', 'bg'],
    ['accent-strong', 'bg'],
];

const CODE_TOKENS = ['code-keyword', 'code-string', 'code-number', 'code-type', 'code-comment'];

const themes = [
    ['light', themeBlock(':root')],
    ['dark', themeBlock(":root[data-theme='dark']")],
] as const;

describe('composite', () => {
    it('blends an 8-digit hex over an opaque one by its alpha', () => {
        expect(composite('#000000ff', '#ffffff')).toBe('#000000');
        expect(composite('#00000000', '#ffffff')).toBe('#ffffff');
        expect(composite('#2e2a240d', '#fbf4e1')).toBe('#f1ead7');
        expect(composite('#f4ead208', '#2e2a24')).toBe('#343029');
    });
});

describe('token contrast', () => {
    it.each(themes)('keeps every text pair at 4.5:1 or better in %s', (_theme, block) => {
        for (const [foreground, background] of TEXT_PAIRS) {
            expect(
                contrast(hex(block, foreground), hex(block, background)),
                `${foreground} on ${background}`,
            ).toBeGreaterThanOrEqual(4.5);
        }
    });

    it.each(themes)('keeps every outline pair at 3:1 or better in %s', (_theme, block) => {
        for (const [foreground, background] of OUTLINE_PAIRS) {
            expect(
                contrast(hex(block, foreground), hex(block, background)),
                `${foreground} on ${background}`,
            ).toBeGreaterThanOrEqual(3);
        }
    });

    it.each(themes)('keeps the code tokens readable on the current line in %s', (_theme, block) => {
        const line = composite(hex(block, 'code-line'), hex(block, 'surface'));
        for (const token of CODE_TOKENS) {
            expect(contrast(hex(block, token), line), `${token} on ${line}`).toBeGreaterThanOrEqual(
                4.5,
            );
        }
    });
});
