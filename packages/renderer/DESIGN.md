# `@platform/renderer` — internals

**TL;DR** — Owns the canvas, the world→screen transform, asset residency, draw order and culling.
Exposes one backend-neutral interface, `IRenderer`, with two implementations behind subpath exports:
`pixi` (PixiJS v8, the real one) and `null` (headless, for tests/CI/server). `@platform/client` drives
it — the renderer owns no clock and no frame loop; nothing draws until `render()` is called. It holds
an authoritative CPU-side scene graph, so the backend's display objects are derived and disposable.

## Layout

| File                    | Owns                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| `index.ts`              | Public barrel — types, `IRenderer`, pure math. **Must not import pixi.** |
| `renderer.ts`           | `IRenderer`, options, node descs, patches, snapshots, events             |
| `node-id.ts`            | `NodeId` brand, `NO_NODE`, pack/unpack                                   |
| `errors.ts`             | `RendererError` + `RendererErrorCode`                                    |
| `surfaces.ts`           | Surface order, camera-transformed / screen-space / clipped predicates    |
| `viewport.ts`           | `fitScale`, `stageRect`, `visibleRect`, `worldViewport`, DPR cap         |
| `projection.ts`         | world↔screen, the y-flip, deg→rad, UI anchors                            |
| `transform-store.ts`    | SoA transform graph, resolve, the two dirty sets                         |
| `node-store.ts`         | Slot table, freelist, generations, `NodeRecord`                          |
| `bounds.ts`             | Local bounds, rotated world AABB, cull test                              |
| `asset-queue.ts`        | Per-name asset intent map + manifest merge                               |
| `core/renderer-core.ts` | Everything backend-independent, in one copy                              |
| `core/scene-sink.ts`    | `SceneSink` — the seam a backend implements                              |
| `null/`                 | `createNullRenderer()`, `NullRenderer`, `NullSink`                       |
| `pixi/`                 | `createPixiRenderer()` + the PixiJS backend (9 files, below)             |

Everything above `core/` is pure: no DOM import, runs in plain Node. That is what makes the
sign-bearing math testable without a browser.

`pixi/`: `pixi-renderer.ts` (orchestration only — `Application`, DPR, `ResizeObserver`, asset
pipeline, presenting a frame) · `pixi-sink.ts` (the only file touching an xform/art pair) ·
`surface-tree.ts` (5 roots, camera, letterbox mask) · `node-tree.ts` (xform/art creation, reparent,
cascade) · `flush.ts` (dirty → local writes + cull toggles) · `asset-registry.ts` (name→`Texture`,
atlas expansion, retained manifest) · `context-guard.ts` (loss/restore state machine) ·
`text-raster.ts` (2D-canvas measure + rasterize) · `text-style.ts` (`TextStyle` → Pixi's).

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
   wraps at generation 128 into handles that collide with live ones.
5. **The y-flip lives only in `projection.ts`**, applied at the write boundary (`pixi.y = -local.y`,
   `pixi.rotation = -deg * DEG2RAD`). The camera root keeps a **positive** uniform scale —
   `root.scale.y = -1` would mirror every sprite and glyph.
6. **The renderer never clamps the camera.** `camera.bounds` is engine-enforced; honoring it here
   double-applies.
7. **Culling toggles `renderable` on `art` only**, never on `xform` — otherwise a culled parent hides
   its children. Groups, UI nodes and `neverCull` nodes are never culled.
8. **Restore merges the retained manifest with the queue _before_ applying**, so a queued unload
   suppresses re-upload. The reverse order resurrects assets a level transition meant to drop.
9. **`preventDefault()` on `webglcontextlost` is mandatory** — without it the browser never fires
   `webglcontextrestored`.
10. **Pure modules never throw.** Degenerate input (a 0×0 container mid-layout, `zoom: 0`, a NaN
    margin) clamps to a finite answer; a NaN reaching `camera.viewport` poisons every later frame with
    no trace of its origin. Validation belongs to the renderer, not the math.

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

**Two dirty sets, and conflating them is the easiest way to break `transform-store.ts`:**

| Set               | Scope       | Marked by                                   |
| ----------------- | ----------- | ------------------------------------------- |
| **resolve-dirty** | subtree     | position / visibility writes, relinks       |
| **flush-dirty**   | single node | any local write that must reach the backend |

A rotation write flush-dirties one node and resolve-dirties nothing — 200 spinning enemies dirty 200
nodes. A parent move writes only the parent's local position, since the backend tree composes.

## Backends

Both are thin shells over one `RendererCore` + a `SceneSink`. The core owns the stores, `createNode`'s
validation _and its order_, hierarchy, the attach/detach asymmetry, `updateSubtree`'s set semantics,
resolve/flush/cull, projection, bounds, `inspect`, `isCulled`, `drawOrderOf`. A sink supplies only:
`create` / `reparent` / `destroySubtree` / `write` / `setRenderable` / `setTexture` / `setText` /
`setLayer` / `sizeOf` / `applyView` / `surfaceVisible` / `setSurfaceVisible` / `clearAll`.

So the semantics the contract suite asserts exist in exactly one place, and its coverage protects both
backends even though it currently only _runs_ against the headless one.

| Genuinely per-backend | `pixi`                                   | `null`                                                           |
| --------------------- | ---------------------------------------- | ---------------------------------------------------------------- |
| `init`                | builds a GPU `Application`               | no DOM; design size _is_ the initial canvas                      |
| `resize`              | resizes the surface                      | records the size                                                 |
| assets                | `Assets` + atlas expansion + placeholder | manifest-declared sizes                                          |
| context loss          | `ContextGuard`                           | `contextState` always `'ok'`; nothing queues                     |
| `sizeOf` for text     | real font metrics                        | `longestLine * size * 0.5` — stable, monotonic, not real metrics |

## Errors: throws vs. no-ops

**Throws** (caller bugs): `not-initialized`, `already-initialized`, `invalid-option`,
`surface-disabled`, `cross-surface-parent`, `cycle`, `text-node-on-world-surface`,
`invalid-node-desc`, `invalid-asset-entry`.

**No-op** (legitimate races): a stale handle. `entity.destroy()` mid-frame followed by a queued patch
is normal; dev builds log once per id. `loadAssets` **resolves with a result rather than rejecting** —
one 404 must not kill a level load; unknown unload names are reported, not thrown.

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
- `cullMargin` is **world px** (default 64), so 64 means the same slack at every zoom. Negative is
  clamped to 0; an inset would invert the axis and grow the rect without bound.
- World text is an **asset first**: `createTextAsset` then a sprite node. `kind: 'text'` is UI-only, so
  `setNodeText` is UI-only too. Measurement uses a 2D canvas, so it works mid-context-loss.
- `destroyNode` cascades. `createNodes` has no intra-batch parenting — a `parent` must already exist.
- A group has no `art`: its rotation/scale/alpha/tint are stored and queryable but inert.
- `inspect()` is the only tooling method and the only allocating one — a fully copied `SceneSnapshot`
  (bounds come from reused scratch rects, so handing them out would alias every node onto the last
  one's extent). It exists on the interface because enumeration is otherwise impossible: every
  per-node query walks _down_ from a handle the caller already holds. Dev only; never per frame, never
  branched on. Returns an empty snapshot before `init` and after `destroy`, never `null`.
- Store ops apply immediately even during a context loss; only GPU ops queue. So the frame loop needs
  no branch and **no caller needs a rebuild path** — node ids survive. `hasAsset` reports _intended_
  state, post-queue. `destroy()` **settles** queued promises cancelled rather than rejecting.
