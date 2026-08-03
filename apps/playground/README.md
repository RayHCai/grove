# @platform/playground

A React harness over `IRenderer` and the PixiJS backend. Click the stage to spawn a leaf; it enters
off the left edge at the height you clicked, tumbles across, and is destroyed once it clears the
right edge.

```bash
pnpm --filter @platform/playground dev     # http://localhost:5173
pnpm --filter @platform/playground test    # the pure sim, in Node
```

The renderer is consumed from `packages/renderer/dist`, so `pnpm --filter @platform/renderer build`
must have run at least once.

## What it exercises

`loadAssets` (a real PNG fetch), sync `createNode`, batched `updateNodes` per frame, `destroyNodes`
(cascading to each leaf's child), `screenToWorld` for pointer mapping, `setCamera` via the zoom
control, the live `viewport`, `inspect()` in the tree panel, and the explicit `render()` call — plus
`ResizeObserver`-driven resize and a mount/unmount/mount cycle under StrictMode.

## The inspector

The panel under the stage is a live `renderer.inspect()` view: surfaces with their roots in draw
order, the node tree, and a detail pane per node. It **polls** (default 4/s, adjustable, freezable)
because `inspect()` allocates per node by design — calling it per frame would make the debugger the
most expensive thing on screen.

Each leaf spawns with a smaller child sprite parented to it, which is what makes §5 visible in the
panel: the child's `resolved pos` tracks its parent while its `rotation` stays 0 — position and
visibility inherit, rotation and scale never do.

Culling only shows up at **zoom 2x or 4x**. At zoom 1 the harness cannot cull at all: `EDGE_MARGIN`
(32) is smaller than the default `cullMargin` (64), so a spawned sprite always straddles the viewport
edge. Zooming shrinks the viewport — at 4x it is `l -120 r 120` — leaving in-flight drifters outside
it, and the `cull` flag lights up.

## Layout

```
index.html            the document; favicon reuses leaf.png
public/leaf.png       16x16 pixel-art sprite, nearest-filtered
src/
├── main.tsx          React root, StrictMode
├── App.tsx           chrome around one <Stage/>
├── Stage.tsx         click -> spawn -> travel -> despawn, the HUD, zoom
├── Inspector.tsx     polled render-tree panel over inspect()
├── use-renderer.ts   the React <-> IRenderer seam: init, frame loop, teardown
├── sim.ts            PURE: the drifter rule. No React, no DOM, no IRenderer
└── styles.css
tests/                sim.ts and the frame-clock helpers, in plain Node
```

`sim.ts` holds no renderer reference, which is what lets the spawn/travel/despawn rule be tested
without a canvas — the same split `@platform/renderer` uses to keep its arithmetic out of the
backend.

## Three things worth knowing

- **The renderer lives in a ref, never in state.** Its identity never changes, and state would
  re-render every consumer for nothing. React state here holds only what the HUD prints, published
  twice a second rather than per frame.
- **Teardown waits for `init()` to settle.** `PixiRenderer.init()` appends its canvas after an
  internal `await`; a `destroy()` arriving in that window finds nothing built, no-ops, and init
  then appends anyway — leaking a live WebGL context. StrictMode's double-mount hits that window
  every time, so `useRenderer` defers the destroy instead (see the `settled` flag).
- **Spawn and exit track the live `viewport`, not the design stage.** A resized window or a zoomed
  camera therefore enters sprites at the edge actually on screen.

## Not a library

This package emits no `dist` types and is imported by nothing — `build` is `vite build`. `tsc` runs
only as a type check (`noEmit`), while staying in the root project references so `tsc -b` at the
repo root still covers it.
