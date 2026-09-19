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

/** The custom properties by name, so a stylesheet-free consumer never repeats a value. */
export const vars = {
    parchment: 'var(--pg-parchment)',
    cream: 'var(--pg-cream)',
    sand: 'var(--pg-sand)',
    moss: 'var(--pg-moss)',
    mossLite: 'var(--pg-moss-lite)',
    olive: 'var(--pg-olive)',
    oliveDeep: 'var(--pg-olive-deep)',
    rust: 'var(--pg-rust)',
    rustLite: 'var(--pg-rust-lite)',
    rustDeep: 'var(--pg-rust-deep)',
    char: 'var(--pg-char)',
    sun: 'var(--pg-sun)',
    bg: 'var(--pg-bg)',
    surface: 'var(--pg-surface)',
    surface2: 'var(--pg-surface-2)',
    surface3: 'var(--pg-surface-3)',
    ink: 'var(--pg-ink)',
    inkMuted: 'var(--pg-ink-muted)',
    inkFaint: 'var(--pg-ink-faint)',
    placeholder: 'var(--pg-placeholder)',
    border: 'var(--pg-border)',
    borderStrong: 'var(--pg-border-strong)',
    accent: 'var(--pg-accent)',
    accentHover: 'var(--pg-accent-hover)',
    accentInk: 'var(--pg-accent-ink)',
    accentSoft: 'var(--pg-accent-soft)',
    accentStrong: 'var(--pg-accent-strong)',
    warm: 'var(--pg-warm)',
    warmHover: 'var(--pg-warm-hover)',
    warmSoft: 'var(--pg-warm-soft)',
    warmInk: 'var(--pg-warm-ink)',
    focus: 'var(--pg-focus)',
    selectionBg: 'var(--pg-selection-bg)',
    selectionInk: 'var(--pg-selection-ink)',
    codeKeyword: 'var(--pg-code-keyword)',
    codeString: 'var(--pg-code-string)',
    codeNumber: 'var(--pg-code-number)',
    codeType: 'var(--pg-code-type)',
    codeComment: 'var(--pg-code-comment)',
    codeSelection: 'var(--pg-code-selection)',
    codeLine: 'var(--pg-code-line)',
    shadowSm: 'var(--pg-shadow-sm)',
    shadowMd: 'var(--pg-shadow-md)',
    bw: 'var(--pg-bw)',
    lift: 'var(--pg-lift)',
    edge: 'var(--pg-edge)',
    liftInk: 'var(--pg-lift-ink)',
    notch: 'var(--pg-notch)',
    notchSm: 'var(--pg-notch-sm)',
    arrow: 'var(--pg-arrow)',
    fontUi: 'var(--pg-font-ui)',
    fontBrand: 'var(--pg-font-brand)',
    fontMono: 'var(--pg-font-mono)',
    ease: 'var(--pg-ease)',
    durFast: 'var(--pg-dur-fast)',
    dur: 'var(--pg-dur)',
    durSlow: 'var(--pg-dur-slow)',
} as const;

/** The 4px spacing scale in pixels, `--pg-sp-1` through `--pg-sp-8`. */
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 48, 8: 80 } as const;

/** The chunky outline and the offset of the solid block a surface drops, in pixels. */
export const pixel = { borderWidth: 3, lift: 4 } as const;

/** The transition durations in milliseconds, `--pg-dur-fast`, `--pg-dur` and `--pg-dur-slow`. */
export const duration = { fast: 120, base: 180, slow: 260 } as const;

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
