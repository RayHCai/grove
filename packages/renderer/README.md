# @platform/renderer

IRenderer interface and the PixiJS implementation.

A backend-neutral `IRenderer` with a PixiJS v8 implementation behind it. The interface names no
Pixi type, so a second backend is a new folder under `src/`, not a rewrite. The full rationale
is in [DESIGN.md](./DESIGN.md); this file is the short version.

## Subpath exports

Importing `@platform/renderer` yields the interface and types **without pulling `pixi.js` into
the module graph** — otherwise anything touching the type (server-side tooling, the panel's type
emission) would drag a WebGL library along.

| Import                    | Gives you                                    |
| ------------------------- | -------------------------------------------- |
| `@platform/renderer`      | `IRenderer`, every type, and the pure math   |
| `@platform/renderer/pixi` | `createPixiRenderer()` — the real backend    |
| `@platform/renderer/null` | `createNullRenderer()` — headless, for tests |

```ts
import type { IRenderer } from '@platform/renderer';
import { createPixiRenderer } from '@platform/renderer/pixi';

const renderer: IRenderer = createPixiRenderer();
await renderer.init({
    container: document.getElementById('stage')!,
    design: { width: 960, height: 540 },
});

await renderer.loadAssets([{ name: 'hero', kind: 'image', url: '/assets/hero.png' }]);

const hero = renderer.createNode({
    kind: 'sprite',
    texture: 'hero',
    surface: 'world',
    position: { x: 0, y: 0 },
    layer: 10,
});

// per frame, from @platform/client — the renderer owns no clock
renderer.updateNodes([{ id: hero, position: { x, y }, rotation: deg }]);
renderer.setCamera({ position: { x: camX, y: camY }, zoom: 1 });
renderer.render();
```

## Five things that surprise people

- **`render()` is explicit.** Nothing draws until you call it, and it takes no `dt` — the
  renderer owns no clock. Frame animation is the client picking a texture name per frame.
- **A child inherits position and visibility. Nothing else, ever.** Rotation, scale, alpha and
  tint stop at the node that declares them, so a nameplate follows its parent without inheriting
  its spin or fade. There is no opt-in mode (§5).
- **World text goes through `createTextAsset` first**, then becomes a sprite node.
  `kind: 'text'` is UI-surface only, and `setNodeText` is therefore UI-only too (§9.3).
- **A context loss needs no caller rebuild path.** Store mutations apply immediately, GPU
  operations queue, and node ids survive — so the frame loop needs no branch (§10).
- **`cullMargin` is world pixels**, not CSS pixels, so 64 means the same slack at every zoom.
- **`inspect()` is the only method for tooling**, and the only one that allocates per call. It
  returns a copied `SceneSnapshot` — roots per surface in draw order, every live node, the view
  state — because enumeration is impossible through the per-node queries, which all walk down from a
  handle you already hold. Dev only: never per frame, never branched on (§11.2).

## Layout

```
src/
├── index.ts            public barrel — types + IRenderer, NO pixi import
├── renderer.ts         IRenderer, options, descs, patches, events
├── node-id.ts          NodeId brand, pack/unpack, NO_NODE
├── errors.ts           RendererError + codes
├── surfaces.ts         PURE: surface order, camera-transformed predicate
├── viewport.ts         PURE: framing + scaleMode -> fitScale, viewport, stageRect
├── projection.ts       PURE: world<->screen, y-flip, deg->rad, UI anchors
├── transform-store.ts  PURE: SoA graph, position/visible resolve, dirty
├── bounds.ts           PURE: local bounds, rotated AABB, cull test
├── node-store.ts       PURE: slot table, freelist, generations
├── asset-queue.ts      PURE: per-name intent map, manifest merge
├── core/               PURE: everything both backends share
│   ├── renderer-core.ts    stores, validation, hierarchy, resolve/cull, projection
│   └── scene-sink.ts       the seam a backend implements
├── null/               headless IRenderer — tests, server, CI
└── pixi/               the PixiJS v8 backend
```

Everything marked PURE has no DOM import and runs in plain Node, which is what makes the
sign-bearing math testable without a browser.

## How the two backends stay in sync

**They share `RendererCore`.** Both `NullRenderer` and `PixiRenderer` are thin shells over the
same core: it owns the two stores, `createNode`'s validation and its order, the
attach/detach asymmetry, `updateSubtree`'s set semantics, the resolve/flush/cull pass, projection
and bounds. A backend supplies only a `SceneSink` — create/reparent/destroy a node's objects, push
its local values, toggle its art, and answer how big it is.

This is deliberately not a "keep these files in sync" convention. Those semantics exist in exactly
one place, so the contract suite's coverage protects both backends even though it currently only
_runs_ against the headless one — verified by mutating the core and watching the suite fail.

What legitimately differs stays per-backend: `init` (only one builds a GPU `Application`), `resize`
(only one resizes a surface), the asset pipeline, the context guard, and `sizeOf` — a GPU backend
measures text with a real font, a headless one cannot.

## Testing

`tests/contract/renderer-contract.ts` is a reusable suite — `runRendererContract(() =>
createNullRenderer())` — covering handle lifecycle, stale-handle no-ops, freelist reuse,
position-only inheritance, destroy cascade, layer reordering, camera/viewport math and transform
round-trips. It runs against `NullRenderer` today; when a browser-mode vitest target exists it
runs unchanged against `PixiRenderer`, and it is the acceptance test for any future backend.

Pixi itself is not unit-tested — there is no WebGL in Node (§15). The mitigation is
architectural: every piece of arithmetic lives in a pure module, and `pixi-renderer.ts` stays
thin delegation. Two things Pixi could get wrong silently are named browser-mode tests rather
than assumptions: dual-composition agreement (§6.5) and `preventDefault()` on
`webglcontextlost` (§10).
