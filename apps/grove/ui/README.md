# @grove/ui

Grove's theme, tokens and core components: **Pixel Grove** in an app-grade React kit — a cozy
retro handheld, with pixel type, chunky borders and stepped sprite motion. It owns no app layout,
no data and no routing; an app composes these components inside a grid of its own.

`apps/design-playground` holds the direction this kit is the implementation of; where the two
disagree, the playground page is the claim to check.

## The language

- **Colour.** The Grove palette (parchment, cream, sand, moss, olive, rust, char, sun) mapped to
  semantic tokens: `--pg-bg` for the chrome field, `--pg-surface` for panes, inputs and secondary
  buttons, `--pg-surface-2` for hover fills and read-only fields, `--pg-ink` and `--pg-ink-muted`
  for text, `--pg-accent` for primary fills with `--pg-accent-soft` for selected and expanded
  states, `--pg-warm` for warm fills with `--pg-warm-ink` for warm text, `--pg-focus` for the
  focus ring, `--pg-plate` with `--pg-plate-ink` for the inked plate a section heading sits on,
  and the `--pg-code-*` set for the code editor. Every pair that carries text passes 4.5:1 in both
  themes and every control outline passes 3:1. The focus ring is `--pg-bw` at `--pg-bw` offset.
- **Type.** VT323 (`--pg-font-ui`) for body copy and field text at 21–22px, Press Start 2P
  (`--pg-font-brand`) for every piece of chrome a person reads as a label — the wordmark, button
  labels at 12px, field labels at 11px, section plates at 13px, badges and tags at 9–10px — and a
  system monospace stack (`--pg-font-mono`) for code and the console. VT323 draws about two thirds
  the height of a proportional face at the same size, which is why 21px here is the old 14px body
  and not a larger one. Font smoothing is off: these faces are meant to look aliased.
- **How a surface is built.** Not a border and a radius. `--pg-bw` (3px) is the outline, `--pg-edge`
  its colour, and every panel, button and popover paints itself through two pseudo-elements sharing
  one `clip-path`: `::after` carries the face as a padding-box gradient under a border-box edge,
  and `::before` is the solid block it drops, offset by `--pg-lift` (4px) in `--pg-lift-ink`. Two
  stepped corners: `--pg-notch` for a panel, `--pg-notch-sm` for a control. `.pg-pixel` in
  `base.css` is that body on its own, for an app element that has to match. There are no radii.
- **Shadows.** Hard offsets, never a blur: `--pg-shadow-sm` is 3px, `--pg-shadow-md` is
  `--pg-lift`, both in `--pg-lift-ink`.
- **Sprites.** `--pg-arrow` is the stepped menu cursor, clipped onto a 12×20 block. It is the
  wordmark's leaf turned upright, and it is what appears beside a button's label while that button
  is the one selected.
- **Motion.** Everything steps and nothing eases: `--pg-ease` is `steps(4, end)` and
  `--pg-step-1` is `steps(1, end)`, at `--pg-dur-fast` 120ms, `--pg-dur` 180ms and
  `--pg-dur-slow` 260ms. `pg-rise` is the four-frame entrance, `pg-blink` the menu cursor and the
  live pip, `pg-bob` the two-frame hover a badge never sits still through, and `pg-float`
  the slower four-frame drift a `.pg-float` wrapper gives something waiting to be clicked (the
  delay that staggers a pair of them belongs to the page). Press feedback moves the face 2px onto
  its own dropped block. `prefers-reduced-motion: reduce` turns every animation and
  transition off outright.
- **Spacing.** `--pg-sp-1` through `--pg-sp-8` (4, 8, 12, 16, 24, 32, 48, 80px); controls are 34px
  tall, or 28px in their small size.

## What it owns

- **The theme.** `src/styles/tokens.css` defines every `--pg-*` custom property on `:root` (light)
  and redefines the semantic colours, the edge and the plate under `:root[data-theme='dark']`; the
  raw palette, spacing, construction, fonts and motion are constant across themes. `ThemeProvider` owns `data-theme`
  on `<html>` and the preference behind it (`'light' | 'dark' | 'system'`, stored in `localStorage`
  under `grove:theme`, `'system'` resolved through `prefers-color-scheme`); `useTheme()` returns
  `{ theme, preference, setPreference }` and `ThemeToggle` flips light and dark explicitly.
- **The tokens in TypeScript.** `vars` holds the custom-property names (`vars.bg === 'var(--pg-bg)'`),
  `space`, `pixel`, `duration` and `fonts` the scalars, and `readThemeColors()` resolves the live
  semantic colours from the root element so no consumer repeats a hex.
- **The components.** `Panel`, `Button`, `IconButton`, `Select`, `Toggle`, `Badge`, `Tag`,
  `Eyebrow`, `SectionTitle`, `TextInput`, `TextArea`, `Progress`, `Tilestrip`, `Wordmark`,
  `VisuallyHidden`, the 16px stroke icons drawn on `Icon`, and `cx()`. Every class is prefixed
  `pg-`; the stylesheet is plain CSS with every colour drawn from a `--pg-*` token.

## Using it

Consumers resolve `@grove/ui` from its built `dist` (`pnpm --filter @grove/ui build`); the package
exports `.` for the components and `./styles.css` for the stylesheet.

The scanline wash is opt-in, because it is fixed over the whole viewport: put `class="pg-scanlines"` on `<body>`.

Import the stylesheet once at the app entry:

```ts
import '@grove/ui/styles.css';
```

The app's `index.html` loads the two fonts:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
    href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&display=swap"
    rel="stylesheet"
/>
```

`ThemeProvider` wraps the app, and this inline script in `<head>` sets `data-theme` before the
first paint so a dark preference never flashes light:

```html
<script>
    (function () {
        var stored = null;
        try {
            stored = localStorage.getItem('grove:theme');
        } catch (e) {}
        var dark =
            stored === 'dark' ||
            (stored !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    })();
</script>
```
