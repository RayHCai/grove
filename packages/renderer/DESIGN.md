# `@platform/renderer` — internals

**TL;DR** — Owns the canvas, the world→screen transform, asset residency, draw order and culling.
Exposes one backend-neutral interface, `IRenderer`, with two implementations behind subpath exports:
`pixi` (PixiJS v8, the real one) and `null` (headless, no DOM). `@platform/client` drives
it — the renderer owns no clock and no frame loop; nothing draws until `render()` is called. It holds
an authoritative CPU-side scene graph, so the backend's display objects are derived and disposable.

## Layout

| File                     | Owns                                                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`               | Public barrel — types, `IRenderer`, pure math, `AssetQueue`, the url-scheme check. **Must not import pixi.**                                                                              |
| `renderer.ts`            | `IRenderer`, options, node descs, patches, snapshots, events                                                                                                                              |
| `node-id.ts`             | `NodeId` brand and `NO_NODE` over math's packed handle                                                                                                                                    |
| `errors.ts`              | `RendererError` + `RendererErrorCode`                                                                                                                                                     |
| `surfaces.ts`            | Surface order, camera-transformed / screen-space / clipped predicates                                                                                                                     |
| `viewport.ts`            | `fitScale`, `stageRect`, `visibleRect`, `worldViewport`, DPR cap                                                                                                                          |
| `projection.ts`          | world↔screen, the y-flip, deg→rad, UI anchors                                                                                                                                             |
| `transform-store.ts`     | SoA transform graph, resolve, the two dirty sets                                                                                                                                          |
| `node-store.ts`          | `NodeRecord` over math's `SlotTable`, labelled `NodeStore`                                                                                                                                |
| `bounds.ts`              | Local bounds, rotated world AABB, cull test                                                                                                                                               |
| `asset-queue.ts`         | Per-name asset intent map, manifest merge, entry validation, the two url-scheme policies — exported, since `@platform/client` merges a mid-session manifest addition against the same map |
| `core/renderer-core.ts`  | The backend-independent scene and frame logic, in one copy                                                                                                                                |
| `core/renderer-shell.ts` | `RendererShell` — `IRenderer`'s backend-independent half, plus the fonts-last unload                                                                                                      |
| `core/scene-sink.ts`     | `SceneSink` — the seam a backend implements                                                                                                                                               |
| `null/`                  | `createNullRenderer()`, `NullRenderer`, `NullSink`                                                                                                                                        |
| `pixi/`                  | `createPixiRenderer()` + the PixiJS backend (8 files, below)                                                                                                                              |

Everything above `core/` is pure: no DOM import, runs in plain Node. That is what keeps the
sign-bearing math reachable without a browser.

`pixi/`: `pixi-renderer.ts` (orchestration only — `Application`, DPR, `ResizeObserver`, asset
pipeline, presenting a frame) · `pixi-sink.ts` (the only file touching an xform/art pair) ·
`surface-tree.ts` (5 roots, camera, letterbox mask) · `node-tree.ts` (xform/art creation, reparent,
cascade) · `asset-registry.ts` (name→`Texture`, atlas expansion, retained manifest, texture release) ·
`context-guard.ts` (loss/restore state machine) · `text-raster.ts` (2D-canvas measure + rasterize,
raster clamps) · `text-style.ts` (`TextStyle` → Pixi's). The per-frame pass is `RendererCore.flush`,
not a `pixi/` file: it is backend-independent, and a per-backend copy drifts from it.

## Invariants — do not break these

1. **`index.ts` must not pull `pixi.js` into the module graph**, transitively either. Server tooling
   and type emission import the interface; they must not drag in WebGL.
2. **Only position and visibility inherit.** Rotation, scale, alpha and tint stop at the node that
   declares them; there is no opt-in mode. Position composition is therefore vector addition — no
   matrix, no decomposition, no shear anywhere. In `pixi/`, this is enforced by _tree shape_: a child
   `xform` is a **sibling** of `art`. Nesting children under `art` silently restores full inheritance.
3. **The store is authoritative; the backend mirrors it.** Queries, culling and post-loss rebuild all
   resolve from our typed arrays. Nothing asks the backend for a transform.
4. **Node ids are arithmetic, never bitwise.** `generation * 2^24 + index`; `<<` coerces to int32 and
   wraps at generation 128 into handles that collide with live ones. The packing lives in
   `@platform/math`, so node and entity handles cannot drift apart.
5. **The y-flip lives only in `projection.ts`**, applied at the write boundary (`pixi.y = -local.y`,
   `pixi.rotation = -deg * DEG2RAD`) and **only for camera-transformed surfaces** — UI is authored
   y-down, so a screen-space node takes the anchor origin and `fitScale` instead. The camera root
   keeps a **positive** uniform scale — `root.scale.y = -1` would mirror every sprite and glyph.
6. **The renderer never clamps the camera** to `camera.bounds`, which is engine-enforced; honoring
   it here double-applies. It does reject a non-finite position or zoom, which would otherwise blank
   every camera-transformed surface.
7. **Culling toggles `renderable` on `art` only**, never on `xform` — otherwise a culled parent hides
   its children. Groups, UI nodes and `neverCull` nodes are never culled.
8. **Restore merges the retained manifest with the queue _before_ applying**, so a queued unload
   suppresses re-upload. The reverse order resurrects assets a level transition meant to drop.
9. **`preventDefault()` on `webglcontextlost` is mandatory** — without it the browser never fires
   `webglcontextrestored`.
10. **Pure modules clamp rather than throw.** Degenerate input (a 0×0 container mid-layout,
    `zoom: 0`, a NaN margin) becomes a finite answer, because a NaN reaching `camera.viewport` poisons
    every later frame with no trace of its origin. Validation belongs to the renderer, not the math —
    the one exception is `NodeStore`, which throws a `RangeError` when all 2^24 slots are live.
11. **The cull pass is O(dirty), not O(scene).** A node's cull answer can only change if its own
    values changed, if its resolved position moved, or if the viewport, a surface's visibility or its
    texture did. A frame in which nothing changed writes nothing and re-culls nothing.
12. **An asset url is parsed, never pattern-matched**, because any character the parser normalises
    away defeats a scheme pattern — `"java\nscript:alert(1)"` matches none, so it reads as a
    relative path. `isAllowedAssetUrl` therefore takes the allowed set: the loader passes
    `LOADER_ASSET_SCHEMES` (`http`/`https`/`data`/`blob`), and `@platform/client` checks a
    server-supplied manifest against the narrower `REMOTE_ASSET_SCHEMES` (`http`/`https`), since a
    peer that can name a `data:` url hands us bytes we never fetched.

## Coordinate spaces

| Space      | Origin          | Y        | Units                           |
| ---------- | --------------- | -------- | ------------------------------- |
| **World**  | stage center    | **up**   | world px                        |
| **UI**     | named anchor    | **down** | design px, scaled by `fitScale` |
| **Screen** | canvas top-left | **down** | CSS px                          |

`Bounds` is `{left, right, top, bottom}`; world rects are y-up, so `top > bottom`. UI is y-down so
`{uiAnchor: 'top-left', position: {x: 20, y: 20}}` reads as "20 in, 20 down". `z` passes through
every function unchanged — reserved for a 3D backend.

## Surfaces

Fixed draw order, bottom to top — not configurable:
`editorSpace` → `world` → `ui` → `editorOverlay` → `editorUi`.

`editorSpace` / `world` / `editorOverlay` are camera-transformed and share **one** camera (that is
what makes a gizmo register with the entity it tracks). `ui` / `editorUi` are screen space.
`editorOverlay` sits above `ui` so a gizmo stays grabbable over the widget it moves. A UI node can
never sort beneath a world node regardless of `layer`.

`enabledSurfaces` defaults to `['world', 'ui']` — a shipped game allocates no editor containers.
Only `editorSpace` / `world` / `ui` are clipped by the letterbox mask; a bar must never cut editor
chrome. Letterboxing is effective only under `framing: 'stage'` **and** `scaleMode: 'fit'` **and**
`letterbox !== false` (`isLetterboxed()`); under `fill`/`expand` world content owns the full canvas.

`fitScale`: `fit` → `min(cw/dw, ch/dh)` · `fill` → `max(…)` · `expand` → `1` · `framing: 'free'` → `1`
(the infinite editor canvas; `zoom` is then literal px per world unit). `stretch` is absent — non-uniform
scale breaks circular colliders' visual match.

## Store shape

```
local:      posX/Y/Z, rot, scaleX/Y/Z, alpha, anchorX/Y, tint    Float64Array
resolved:   posX/Y/Z                                             Float64Array   ← only these
flags:      visible, resolvedVisible, neverCull, culled          Uint8Array
tree:       parent, firstChild, lastChild, prevSibling,
            nextSibling, depth                                   Int32Array
```

No resolved rotation/scale/alpha because local _is_ resolved for those (invariant 2). `Float64Array`
because composed positions accumulate. Intrusive sibling lists mean hierarchy costs no per-node
allocation. `NodeStore` holds the non-numeric per-node data (`NodeRecord`) at the **same slot index**,
which is why slots reuse densely and `slotCount` never shrinks.

**Three dirty sets, and conflating the first two is the easiest way to break
`transform-store.ts`:**

| Set                  | Scope       | Marked by                                   | Drained by     |
| -------------------- | ----------- | ------------------------------------------- | -------------- |
| **resolve-dirty**    | subtree     | position / visibility writes, relinks       | `resolve()`    |
| **flush-dirty**      | single node | any local write that must reach the backend | the flush pass |
| **resolved-changed** | single node | a resolve that actually moved a node        | the cull pass  |

A rotation write flush-dirties one node and resolve-dirties nothing — 200 spinning enemies dirty 200
nodes. A parent move writes only the parent's local position, since the backend tree composes; its
children reach the cull pass through resolved-changed, which accumulates until it is drained rather
than describing only the last `resolve()`.

## Backends

Both extend `RendererShell` over one `RendererCore` + a `SceneSink`. The core owns the stores,
`createNode`'s validation _and its order_, hierarchy, the attach/detach asymmetry, `updateSubtree`'s
set semantics, resolve/flush/cull, projection, bounds, `inspect`, `isCulled`, `drawOrderOf`. The
shell owns every `IRenderer` member that is pure delegation to the core, the no-op-before-`init`-and-
after-`destroy` rule, the fonts-last unload, and `teardownCore`, which drops the core and the
deferred asset work for a backend's `destroy` to call around releasing its own fields — so a backend
declares only `init`, `destroy`, `render`, its surface resize, its context state, its asset pipeline,
its residency and its text measurement. A sink supplies only: `create` / `reparent` /
`destroySubtree` / `write` / `setRenderable` / `setTexture` / `setText` / `setLayer` / `sizeOf` /
`applyView` / `surfaceVisible` / `setSurfaceVisible` / `clearAll`. A sink also places screen-space
nodes, since the anchor origin and `fitScale` are the backend's to apply.

So every one of those semantics exists in exactly one place — `renderer-core.ts` or
`renderer-shell.ts` — and both backends inherit it rather than each restating it.

| Genuinely per-backend | `pixi`                                           | `null`                                                           |
| --------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| `init`                | builds a GPU `Application`                       | no DOM; design size _is_ the initial canvas                      |
| `resizeSurface`       | resizes the GPU surface                          | no drawing surface, so nothing to resize                         |
| assets                | `Assets` + atlas expansion + placeholder         | manifest-declared sizes                                          |
| context loss          | `ContextGuard`; a lost WebGPU device is terminal | `contextState` always `'ok'`; nothing queues                     |
| `sizeOf` for text     | real font metrics                                | `longestLine * size * 0.5` — stable, monotonic, not real metrics |

## Errors: throws vs. no-ops

**Throws** (caller bugs): `already-initialized`, `invalid-option`, `surface-disabled`,
`cross-surface-parent`, `cycle`, `text-node-on-world-surface`, `invalid-node-desc`,
`invalid-asset-entry` (also from `loadAsset`, the singular form). `not-initialized` is reserved and
never thrown: a call before `init` or after `destroy` is a silent no-op instead, which is what lets a
panel mount around a renderer's lifetime without guarding every call.

**No-op** (legitimate races): a stale handle — `entity.destroy()` mid-frame followed by a queued patch
is normal, and it is dropped silently, since the package logs nothing in any build. `loadAssets`
**resolves with a result rather than rejecting** — one 404, or one structurally invalid entry, must not
kill a level load; unknown unload names are reported, not thrown.

## API notes not visible in the signatures

- `createNode` is **synchronous** — `game.spawn` is specified sync and always safe, and the engine
  needs the handle immediately. `createNodeAsync` covers callers that need the resolved size.
- `updateNodes` **retains nothing** past the call, so a caller may recycle a pooled `NodePatch[]` and
  hit zero allocation. `undefined` field = unchanged.
- `attachNode` reinterprets (`keepResolvedPosition` defaults `false`), `detachNode` preserves
  (defaults `true`) — matching `attachTo` / `detach` in `api_spec.ts`.
- `layer` on a parented node is **sibling order**, not a global layer; within a layer, order is
  insertion-defined and stable. A child at the default layer draws in front of its parent's art.
- `anchor` defaults to `(0.5, 0.5)` — a negative-x flip pivots about the anchor, and centered flips in
  place. This differs from raw Pixi's `(0, 0)`, so `art.anchor` is set explicitly on every sprite.
- `cullMargin` is **world px** (default 64), so 64 means the same slack at every zoom. `init` rejects
  a negative one; `isVisibleInViewport` clamps one anyway, because an inset would invert the axis and
  grow the rect without bound.
- World text is an **asset first**: `createTextAsset` then a sprite node. `kind: 'text'` is UI-only, so
  `setNodeText` is UI-only too. Measurement uses a 2D canvas, so it works mid-context-loss.
- `destroyNode` cascades. `createNodes` has no intra-batch parenting — a `parent` must already exist;
  `createSubtree` has it, through a `parentInBatch` that must name an EARLIER desc, and it rolls the
  whole batch back if one desc throws, since the caller holds no handle to a half-built subtree.
- A group has no `art`: its rotation/scale/alpha/tint are stored and queryable but inert.
- `inspect()` is the only tooling method, and the only one that allocates **per node** — a fully
  copied `SceneSnapshot`, because bounds come from reused scratch rects and handing them out would
  alias every node onto the last one's extent. The bounds and transform queries allocate one rect per
  call for the same reason, as do `viewport` and `stageRect`; only the frame path is allocation-free.
  `inspect` exists on the interface because enumeration is otherwise impossible: every per-node query
  walks _down_ from a handle the caller already holds. Dev only; never per frame, never branched on.
  Returns an empty snapshot before `init` and after `destroy`, never `null`.
- A **UI node** is placed at its surface root's `uiAnchor` origin plus its resolved offset scaled by
  `fitScale`, y-down. `uiAnchor` is read from the root, not from each node, so a parented HUD element
  does not add a second origin — and its art scales with the stage, since a HUD is authored in design
  px.
- **Text is clamped** before it reaches the GPU: 4096 characters, a 512px font size and a raster no
  larger than 4096px per axis, whatever `style.resolution` asks for. A player name is caller input.
- Store ops apply immediately even during a context loss; only GPU ops queue. So the frame loop needs
  no branch and **no caller needs a rebuild path** — node ids survive. `hasAsset` reports _intended_
  state, post-queue, and a result's `queued` is `true` exactly when the work was deferred. `destroy()`
  **settles** queued promises cancelled rather than rejecting, each with its own result shape.
- **The restore is the only thing that applies queued asset work.** A mid-loss call records intent and
  reports it; nothing replays, because the merge would then run twice. A step that throws leaves the
  state `'ok'` with a reported failed asset rather than `'restoring'` forever, which would stop
  `render()` for the rest of the session.
