# @grove/design-playground

Grove's chosen design direction: **Pixel Grove** — a cozy retro handheld with pixel type, chunky
borders, and stepped sprite motion. Warm, modern, sleek, inviting, playful, homey — built first
for kids.

The playground previously held twelve competing directions; the others have been retired and
Pixel Grove is the one that stayed.

## Run

```sh
pnpm --filter @grove/design-playground dev
```

Then open <http://localhost:5180>.

## Layout

- `src/index.html` — the hub.
- `src/pages/pixel.html` — the design page, self-contained (inline CSS and JS).
- `CONTENT.md` — the canonical content the page renders, and the rules it follows. Edit content
  there first, then mirror it into the page.
