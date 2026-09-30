const HEX_TOKENS = [
    'bg',
    'surface',
    'surface-2',
    'surface-3',
    'ink',
    'ink-muted',
    'ink-faint',
    'placeholder',
    'border',
    'border-strong',
    'accent',
    'accent-hover',
    'accent-ink',
    'accent-soft',
    'accent-strong',
    'warm',
    'warm-hover',
    'warm-soft',
    'warm-ink',
    'sun',
    'olive',
    'focus',
    'selection-bg',
    'selection-ink',
    'code-keyword',
    'code-string',
    'code-number',
    'code-type',
    'code-comment',
    'code-selection',
    'code-line',
] as const;

/** A semantic colour token whose live value is a hex string; the shadows are not one. */
export type HexToken = (typeof HEX_TOKENS)[number];

/** The live colours of the active theme, `#rrggbb` or `#rrggbbaa`, keyed by token name. */
export type ThemeColors = Record<HexToken, string>;

/** The three font stacks, identical to `--pg-font-ui`, `--pg-font-brand` and `--pg-font-mono`. */
export const fonts = {
    ui: "'VT323', 'Courier New', monospace",
    brand: "'Press Start 2P', 'Courier New', monospace",
    mono: "ui-monospace, 'Cascadia Code', 'Cascadia Mono', Consolas, 'JetBrains Mono', 'Fira Code', Menlo, 'DejaVu Sans Mono', 'Liberation Mono', monospace",
} as const;

/** Resolves the active theme's colours from the root element, so nothing else holds a hex. */
export function readThemeColors(): ThemeColors {
    const style = getComputedStyle(document.documentElement);
    const colors = {} as ThemeColors;
    for (const token of HEX_TOKENS) {
        colors[token] = style.getPropertyValue(`--pg-${token}`).trim();
    }
    return colors;
}
