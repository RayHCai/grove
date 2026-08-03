# `@platform/renderer` — MVP design

Status: **implemented.** The pure modules, the null backend, the contract suite and the PixiJS backend
are all in place; §16's build order was followed start to finish. Four points this document left
underspecified were settled during implementation — see [§18](#18-open-questions).

A backend-neutral `IRenderer` interface with a PixiJS v8 implementation behind it. The interface names no
Pixi type, so a Three.js backend would be a new folder under `src/`, not a rewrite. Section references
like §3.3 point at [`api_design.md`](../../api_design.md); line references point at
[`api_spec.ts`](../../api_spec.ts).

---

## 1. Scope

**The renderer owns** the canvas and its GPU context; the world→screen transform including the y-up→y-down
flip (§2); the viewport (`camera.viewport` at api_spec.ts:312 is "engine-computed from position, zoom, and
the client's window" — the window is only visible here); texture/atlas/font residency and the
`name → GPU resource` map; draw order from `Entity.layer`; culling; its own authoritative scene graph.

**It does not own** the frame loop (`@platform/client` calls `render()`); interpolation, prediction, or
reconciliation; input capture — though it must expose `screenToWorld`, because it holds the transform;
`camera.shake` (engine computes a per-frame offset and passes it through `setCamera`); frame-animation
state machines (§4.2) — the client picks a texture name per frame and pushes it via `updateNodes`.

---

## 2. Primitives live in `@platform/math`

`Vec3`, `Vec3Like`, `Bounds`, `Size` go in `@platform/math`, which today is a shell exporting only
`PACKAGE_NAME`. `packages/renderer/package.json` already declares `@platform/math` as a dependency and
`tsconfig.json` already has the project reference, so no wiring changes — only new files.

`api_spec.ts:41` declares `Vec3` inside `declare module '@platform/engine'`; that file is a spec artifact,
not compiled code. The real implementation lands in math, and `@platform/engine` re-exports it so the
creator-facing name in the spec resolves to one type.

```ts
// packages/math/src/vec3.ts
export interface Vec3 {
    x: number;
    y: number;
    z: number;
} // matches api_spec.ts:41
export interface Vec3Like {
    x: number;
    y: number;
    z?: number;
}

// packages/math/src/bounds.ts
export interface Bounds {
    left: number;
    right: number;
    top: number;
    bottom: number;
}
export interface Size {
    width: number;
    height: number;
}
```

**Why both `Vec3` and `Vec3Like`.** `Vec3` requires all three axes; §2 says `z` defaults to 0. `Vec3Like`
is the _parameter_ type — write `{x: 10, y: 5}` and omit `z`. `Vec3` is the _return_ type, always fully
populated. Without the split every call site pads `z: 0` by hand.

Also add the pure helpers `@platform/math` is described as owning and that this package needs:
`vec3` / `vec3Set` / `vec3Copy` (allocation-free, `out`-parameter style), `clamp`, `lerp`, `DEG2RAD`.
`api_spec.ts:74-91` also puts `clamp`, `lerp`, and seeded `random` on the creator surface — same home.

---

## 3. Coordinate spaces

| Space      | Origin                  | Y        | Units                             | Used by                                          |
| ---------- | ----------------------- | -------- | --------------------------------- | ------------------------------------------------ |
| **World**  | stage center            | **up**   | world px                          | `'world'` surface, `viewport`, `Entity.position` |
| **UI**     | the node's named anchor | **down** | design px (scales with the stage) | `'ui'` surface                                   |
| **Screen** | canvas top-left         | **down** | CSS px                            | pointer events, `worldToScreen` output           |

**UI is y-down and anchor-relative** because §12.1 already defines placement as "a named anchor plus
panel-authored offset": `{ uiAnchor: 'top-left', position: {x: 20, y: 20} }` reads as "20 in from the left,
20 down from the top." Two y conventions in one API is a real cost; it buys anchor offsets that don't read
backwards.

**UI is design pixels, not CSS pixels**, scaled by the same `fitScale` as the world, so a HUD authored
against a 960×540 stage lands identically on every screen. (Open question 3.)

---

## 4. Surfaces

```ts
type Surface = 'editorSpace' | 'world' | 'ui' | 'editorOverlay' | 'editorUi';
```

Fixed draw order, bottom to top: **`editorSpace` → `world` → `ui` → `editorOverlay` → `editorUi`**.

- `editorSpace` — infinite canvas backdrop. Camera-transformed, below world.
- `world` — game content. Camera-transformed.
- `ui` — game HUD. Screen space.
- `editorOverlay` — gizmos, selection, handles. Camera-transformed, above world **and above `ui`**, so a
  gizmo stays grabbable over the widget it moves.
- `editorUi` — editor chrome. Screen space, topmost.

Ordering is not configurable; a sixth surface would be an API version, not a runtime argument. A UI node
can never sort beneath a world node regardless of `layer`.

**"Surface" vs. "layer" is a deliberate distinction.** `layer` is already taken — `Entity.layer` is the
draw-order ordinal (api_spec.ts:184). A surface is one of the five roots; a layer is a `number` ordinal
_within_ a surface.

**One renderer, not one per surface.** One canvas, one GPU context, one draw list, one asset registry, one
context-loss path. `enabledSurfaces` defaults to `['world', 'ui']`, so a shipped game never allocates
editor containers; the editor passes all five. `setSurfaceVisible` toggles the editor stack for play-mode
preview in one call.

**The three camera-transformed surfaces share one camera** — that is what makes a gizmo register with the
entity it is attached to. Separate cameras would guarantee drift.

### 4.1 Framing

`CameraState.framing` is what makes the editor space infinite:

| `framing`           | `fitScale`                                 | Letterbox | `stageRect`           | Use    |
| ------------------- | ------------------------------------------ | --------- | --------------------- | ------ |
| `'stage'` (default) | `min`/`max`(canvas/design) per `scaleMode` | yes       | the letterboxed stage | game   |
| `'free'`            | `1` — `zoom` is literal px per world unit  | no        | the full canvas       | editor |

Under `'free'`, panning is unbounded `camera.position`. **The renderer never clamps a camera** in either
mode: `camera.bounds` is engine-enforced (§3.3), and honoring it here would double-apply.

### 4.2 Scale modes

| Mode            | `fitScale`          | Everyone sees the same world?      |
| --------------- | ------------------- | ---------------------------------- |
| `fit` (default) | `min(cw/dw, ch/dh)` | **yes**, with letterbox bars       |
| `fill`          | `max(cw/dw, ch/dh)` | no — crops                         |
| `expand`        | `1`                 | no — bigger screens see more world |

Default `fit` + `letterbox: true`. Grove is Scratch-adjacent: a creator places things by eye against a
fixed stage, and a competitive game where a widescreen player sees more of the arena is a fairness bug.
This does not invalidate §3.3's rule that `camera.viewport` is unreadable from a `SyncedScript` — the mode
is configurable and DPR rounding still differs per client, so the load-time restriction stays correct.

`stretch` is deliberately absent: non-uniform scale breaks circular colliders' visual match.

Viewport under `fit` + letterbox, in world coords:

```
halfW = design.width  / (2 * zoom)
halfH = design.height / (2 * zoom)
{ left: cx - halfW, right: cx + halfW, top: cy + halfH, bottom: cy - halfH }
```

Note `top > bottom` under y-up. See open question 2.

---

## 5. Hierarchy carries position only

**The rule: a child inherits its parent's position and visibility. Nothing else, ever.** Rotation, scale,
alpha, and tint stop at the node that declares them. There is no opt-in mode.

The rationale is stronger than convenience. **Nested non-uniform scale with an intervening rotation
produces shear**, and shear is not representable in a `{position, rotation, scale}` transform — a standard
scene graph must either carry a full 2×3 matrix (and then `resolvedTransformOf` cannot return a decomposed
`Transform` at all) or silently approximate. Cutting scale inheritance makes the entire class unreachable:
no skew, no non-uniform surprises, no matrix decomposition anywhere in the store.

Three consequences:

- **Matches the spec exactly.** `attachTo` at api_spec.ts:204 says "position becomes local to parent" and
  is silent on every other channel. No spec change and no mode argument needed.
- **Dirty propagation narrows.** Only position and visibility propagate, so writing rotation/scale/alpha/
  tint dirties **one node, not a subtree**. 200 spinning enemies dirty 200 nodes.
- **The common 2D case needs no annotation** — nameplates, health bars, bubbles, markers and selection
  rings follow position without inheriting spin or fade.

`scale` stays per-axis (`Vec3Like`); negative x for a horizontal flip is the common case, and with no
composition a single node's non-uniform scale carries no shear risk.

**Visibility does inherit**, structurally (it is `xform.visible`). Hiding a character while its hat floats
on is almost certainly a bug, and `destroy` already cascades. See open question 4.

**`anchor` is not hierarchy.** `anchor` is the 0..1 pivot inside a node's own art; `parent` is hierarchy.
Both were called "anchoring" in early discussion, so they keep distinct words.

### 5.1 Bulk changes

Since nothing inherits, changing appearance across an assembly needs an explicit one-shot fan-out:

```ts
updateSubtree(root, patch, opts?: { includeRoot?: boolean }): void;   // set-only
```

Set semantics only — idempotent, no float accumulation, no baseline to track. It writes each descendant's
own local values and establishes no inheritance, so a node attached later is unaffected. That is the
correct reading of a one-shot bulk change.

The honest cost: `{alpha: 0.5}` **flattens** a subtree that had varied alphas rather than scaling them
proportionally. A caller wanting proportional change reads `localTransformOf` per node and writes explicit
values through `updateNodes`. Predictable beats convenient.

---

## 6. The renderer owns the scene graph

**We keep our own authoritative transform store. Pixi's tree is nested and mirrors ours; we write LOCAL
values into it and let Pixi compose for drawing. Our store resolves independently, for queries, culling,
and post-context-loss rebuild.** `worldToScreen` / `screenToWorld` compute from our numbers with our
constants and never ask Pixi.

### 6.1 The store

Structure-of-arrays over growable typed arrays, indexed by the node id's slot index:

```
local:      posX/Y/Z, rot, scaleX/Y/Z, alpha, anchorX/Y, tint    Float64Array
resolved:   posX/Y/Z                                             Float64Array  <- only these
flags:      visible, resolvedVisible, neverCull, culled          Uint8Array
tree:       parent, firstChild, lastChild, prevSibling,
            nextSibling, depth                                   Int32Array
```

There is no resolved rotation, scale, or alpha, because for those local _is_ resolved (§5).
`resolvedTransformOf` still returns a full `Transform` for uniformity; only `position` and `visible` can
differ from `localTransformOf`.

`Float64Array` over `Float32Array`: composed positions accumulate, and at Grove's scale (hundreds to low
thousands of nodes) the memory difference is irrelevant while the drift is not. Intrusive sibling lists
mean hierarchy costs no per-node array allocation.

**Dirty propagation:** writing position or visibility marks that node's subtree dirty; writing anything
else marks only that node. `render()` resolves by DFS from each dirty root, parent before child, skipping
clean subtrees.

### 6.2 Pixi mapping — two objects per node

```
xform  (Container)   position = (local.x, -local.y)
                     visible  = local.visible
                     sortableChildren = true
  ├─ art  (Sprite | Text)          zIndex = 0, inserted first
  │        scale    = local.scale
  │        rotation = -local.rotation * DEG2RAD
  │        alpha    = local.alpha
  │        tint     = local.tint
  │        anchor   = local.anchor
  └─ child xform, child xform, …   zIndex = child.layer
```

**`xform` carries only what inherits; `art` carries only what does not.** §5's rule is enforced by tree
shape — a child is a _sibling_ of `art`, so it is structurally incapable of picking up the parent's scale,
rotation, alpha, or tint. No per-frame bookkeeping in `flush`, nothing to get wrong.

`sortableChildren` on `xform` is load-bearing: `xform.children` is `[art, ...children]`, and that is the
list needing order. `art.zIndex = 0` inserted first; child `zIndex = layer`. Pixi's sort is stable, so ties
break by insertion order and **a child with the default `layer` draws in front of its parent's art** — a
hat over a head, the intuitive default. Negative `layer` puts it behind.

A group node has no `art`, so its `xform` holds only children: sprites cost 2 display objects, groups cost

1. **A group's own rotation, scale, alpha and tint are inert** — stored, queryable, never drawn, never
   inherited. A group is a positional pivot and nothing more.

### 6.3 The y-flip

World is origin-center y-up; Pixi is origin-top-left y-down. The tempting implementation is
`root.scale.y = -1`. **That is wrong** — it mirrors every sprite and glyph. The flip is arithmetic at the
write boundary, in exactly one function:

```
pixi.x        =  local.x
pixi.y        = -local.y
pixi.rotation = -local.rotation * DEG2RAD
```

### 6.4 Camera on the surface root

The camera is applied by the surface root container, never baked into node values, so `setCamera` touches
one container and zero nodes:

```
s = fitScale(framing, scaleMode, canvas, design) * zoom
root.scale    = s                                     // uniform, POSITIVE
root.position = { x: cw/2 - cam.x * s, y: ch/2 + cam.y * s }
```

Composing: `screenX = cw/2 + (worldX - cam.x) * s`, `screenY = ch/2 + (cam.y - worldY) * s`.

### 6.5 The cost, stated

Two composition paths must agree, so this needs a **consistency test**: for a randomly generated tree, our
`resolvedTransformOf(id).position` must match Pixi's `getGlobalPosition` mapped back through the camera.
It is a browser-mode test. §5 makes it much likelier to pass — position-only composition is addition, which
is associative and exact.

We also lose Pixi's container-level culling; we do our own from the store (§8), which is cheaper anyway
because it is a flat scan over typed arrays.

---

## 7. Node ids

Packed: `generation * 2^24 + index`. 16.7M live nodes, 2^26 reuses per slot, all inside
`Number.MAX_SAFE_INTEGER`.

- `NO_NODE = 0`; generations start at 1, so a zeroed field is never a valid handle.
- **Must be arithmetic, not `<<`/`|`.** Bitwise ops in JS coerce to int32, so `gen << 24` wraps at
  generation 128. This is the single most likely implementation bug in the package, so it gets a named
  test.
- Slot table plus freelist. `destroyNode` bumps the generation, so a stale handle fails the generation
  check.
- **Stale handles are a no-op, not a throw**, matching "sending to a dead entity is a no-op that resolves"
  (api_design.md:918). A stale handle arises from a legitimate race — `entity.destroy()` mid-frame. Dev
  builds log once per id.
- **Cross-surface parenting and cycles throw.** Those are caller bugs, not races.
- `kind` lives in the slot record, not in the packed id: validation reads the slot anyway.

---

## 8. Culling

Size-aware, from per-node local bounds:

| Kind        | Local bounds                                   |
| ----------- | ---------------------------------------------- |
| `sprite`    | texture size × local scale, offset by `anchor` |
| `text` (UI) | measured — UI is never culled                  |
| `group`     | zero extent — groups are never culled          |

Rotation expands to the exact AABB of the rotated rect. Because rotation and scale do not inherit, this
reads **only the node's own** values — no ancestor walk:

```
hx' = |cos θ|·hx + |sin θ|·hy
hy' = |sin θ|·hx + |cos θ|·hy
```

**`cullMargin` is WORLD pixels** (default 64), added to the viewport rect before the overlap test. World px
is the right unit because entity sizes are in world px: 64 always means "about one tile of slack"
regardless of zoom. In CSS px it would mean a different amount of world at every zoom level, so a
zoomed-out editor view would pop sprites while a zoomed-in game view over-drew.

Culling toggles `renderable` on **`art` only**. Children are siblings of `art`, so culling a parent cannot
hide them — another consequence of §6.2's shape. Groups are never culled, so no subtree is dropped
wholesale in MVP; per-subtree bounds union is a measured optimization for later. `neverCull` per node for
visuals that exceed their bounds (thick stroke, glow, emitter).

`worldBoundsOf(id)` is public rather than internal: the editor needs it for selection rectangles and
marquee hit-tests, and it is the identical computation.

---

## 9. Assets

### 9.1 Uniform async shape

Every loading entry point is async and resolves to `AssetInfo`, so a caller learns real dimensions from the
load itself rather than a follow-up `getAssetSize`.

```ts
interface AssetInfo {
    name: string;
    size: Size;
}
interface AssetFailure {
    name: string;
    reason: string;
}
```

**`createNode` stays synchronous, returning `NodeId`** — a deliberate exception. api_design.md:1106
specifies `scene.spawn('coin', x, y)` as "synchronous and always safe," and the engine needs the handle
immediately to store on the entity. Async would force `scene.spawn` async or make the engine hold a
pending-id table. `createNodeAsync` covers callers that want the resolved size — chiefly the editor, sizing
a selection box around a just-dropped sprite.

`loadAssets` **resolves with a result rather than rejecting**, so one 404 sprite does not kill a level load.
A node naming a missing texture gets a magenta placeholder and one warning — the friendly failure mode, and
consistent with the engine owning the lifecycle.

This does not contradict §3.6's "there is no `assets.load`": that rule governs the _creator-facing_ API.
`loadAssets` is the plumbing the panel's preloader calls.

### 9.2 Unloading

- Takes names or original entries; names are canonical. Entries work because the manifest is retained for
  context-loss recovery anyway.
- **In-use textures unload anyway** and are reported. A level transition genuinely wants to force it, and
  refusing would make the caller destroy nodes in a particular order. Affected nodes fall back to the
  placeholder; their ids stay valid.
- Unknown names are reported, not thrown — idempotent teardown needs no guard.
- **Fonts unload last**, and one still referenced by a live text node is kept and reported `inUse`:
  dropping it re-rasterizes to a fallback face, which reads as corruption rather than as a missing asset.

### 9.3 World text is an asset first

`TextNodeDesc` is **UI-surface only**. World text goes through the asset path:

```ts
createTextAsset(name, text, style?): Promise<AssetInfo>;
// then: createNode({ kind: 'sprite', texture: name, surface: 'world', ... })
```

A `kind: 'text'` manifest entry means text assets participate uniformly in retention, unloading, queueing,
and post-loss re-upload — no special case anywhere. Creating a `kind: 'text'` node on a camera-transformed
surface is a create-time error whose message points at `createTextAsset`.

What it buys: culling is **exact** (world text has a texture size — §8 needs this); no font residency
problem in world space; no per-frame text re-measurement; and zoom blur becomes explicit rather than magic
— the caller picks `style.resolution` and re-rasterizes deliberately.

What it costs, plainly: **`setNodeText` is UI-only.** Changing world text means a new text asset and a
`texture` swap. For `entity.say()` (§3.8) the engine will want an LRU cache keyed on a text+style hash with
a budget, since a game generating unique strings per frame would churn assets. **That cache belongs to the
engine, not the renderer.**

Rasterizing needs a 2D canvas, **not** WebGL — so `createTextAsset` measures and resolves with a real size
even while the GPU context is lost. Only the upload queues, so layout never blocks.

---

## 10. Context loss

The split that makes this work: **store mutations apply immediately, GPU operations queue.**

| Operation                                                                              | During `'lost'` / `'restoring'`                |
| -------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `createNode`, `updateNodes`, `updateSubtree`, `destroyNode`, `attachNode`, `setCamera` | **immediate** — the store is CPU-side          |
| `loadAsset(s)`, `unloadAssets`, `createTextAsset`                                      | **queued**; the promise resolves after restore |
| `render()`                                                                             | no-op                                          |

So the client's frame loop needs no branch, and **no caller needs a rebuild path** — node ids survive a
loss. That is the payoff of §6: the store is the source of truth and the Pixi objects are derived.

**Queue semantics.** A **per-name intent map, not a log**: `load('a')` → `unload('a')` → `load('a')`
collapses to a net load, naturally bounded by the number of distinct asset names, so no growth cap is
needed. **Restore merges the retained manifest with the queue** before applying, so a queued unload
suppresses re-upload of something resident before the loss — backwards, this resurrects assets a level
transition meant to drop.

`hasAsset` reports **intended** state (post-queue), not GPU state, so a caller cannot branch wrongly
mid-loss. `getAssetSize` answers from a manifest-declared `size` when present, from measurement for text
assets, else `null`. `destroy()` **settles** queued promises with a cancelled result rather than rejecting,
so teardown produces no unhandled rejections.

```
webglcontextlost   ->  preventDefault()  ->  'lost'  ->  emit 'contextlost'
webglcontextrestored / GPUDevice.lost resolution
                   ->  'restoring'
                   ->  merge retained manifest + queued intents; re-upload
                   ->  recreate xform/art pairs from our node records
                   ->  mark all dirty; full flush
                   ->  'ok'  ->  emit 'contextrestored' { reloadedAssets, failedAssets }
```

**`preventDefault()` on `webglcontextlost` is mandatory** — without it the browser never fires
`webglcontextrestored`. Classic gotcha, so it gets a named test. WebGPU device loss folds into the same two
events; the backend difference is not the caller's business. `contextrestored` reports failed reloads
because a loss during a network outage is a real combination.

---

## 11. The interface

```ts
import type { Vec3, Vec3Like, Bounds, Size } from '@platform/math';

// ─── handles ────────────────────────────────────────────────────────
// generation * 2^24 + index. Arithmetic, NOT bitwise: `<<` is int32 in JS and
// would wrap past generation 128.
export type NodeId = number & { readonly __nodeId: unique symbol };
export const NO_NODE = 0 as NodeId;

// ─── surfaces, modes ────────────────────────────────────────────────
export type Surface = 'editorSpace' | 'world' | 'ui' | 'editorOverlay' | 'editorUi';
export type Framing = 'stage' | 'free'; // 'free' = infinite editor pan
export type ScaleMode = 'fit' | 'fill' | 'expand';
export type TextureFilter = 'nearest' | 'linear';
export type ContextState = 'ok' | 'lost' | 'restoring';
export type UiAnchor =
    // mirrors HudAnchor, api_spec.ts:59
    | 'top-left'
    | 'top-center'
    | 'top-right'
    | 'middle-left'
    | 'center'
    | 'middle-right'
    | 'bottom-left'
    | 'bottom-center'
    | 'bottom-right';

export interface CameraState {
    position: Vec3Like;
    zoom: number;
    framing?: Framing;
}

// ─── init ───────────────────────────────────────────────────────────
export interface RendererInitOptions {
    container: HTMLElement;
    design: Size; // the reference stage, in world px
    enabledSurfaces?: readonly Surface[]; // default ['world', 'ui']
    scaleMode?: ScaleMode; // default 'fit'
    letterbox?: boolean; // default true; forced off under 'free'
    background?: number | 'transparent';
    maxResolution?: number; // DPR cap, default 2
    defaultFilter?: TextureFilter; // default 'nearest' — kid-drawn pixel art
    antialias?: boolean; // default false
    autoResize?: boolean; // default true — internal ResizeObserver
    cullMargin?: number; // WORLD px of slack, default 64
    preference?: 'webgl' | 'webgpu'; // default 'webgl'; both loss paths handled
}

// ─── assets ─────────────────────────────────────────────────────────
export type AssetManifestEntry =
    | { name: string; kind: 'image'; url: string; filter?: TextureFilter; size?: Size }
    | { name: string; kind: 'atlas'; url: string; filter?: TextureFilter }
    | { name: string; kind: 'font'; url: string; family?: string }
    | { name: string; kind: 'text'; text: string; style?: TextStyle };

export interface AssetInfo {
    name: string;
    size: Size;
}
export interface AssetFailure {
    name: string;
    reason: string;
}

export interface AssetLoadResult {
    loaded: AssetInfo[];
    failed: AssetFailure[];
    queued: boolean; // deferred past a context loss
}
export interface AssetUnloadResult {
    unloaded: string[];
    unknown: string[]; // never loaded — not an error
    inUse: Array<{ name: string; nodeCount: number }>; // unloaded anyway; placeholder shows
    queued: boolean;
}

// ─── nodes ──────────────────────────────────────────────────────────
export interface TextStyle {
    font?: string;
    size?: number;
    color?: number; // 0xRRGGBB
    align?: 'left' | 'center' | 'right';
    weight?: 'normal' | 'bold';
    italic?: boolean;
    stroke?: { color: number; width: number };
    wrapWidth?: number;
    lineHeight?: number;
    resolution?: number; // raster scale for text assets
}

interface NodeBase {
    surface?: Surface; // default 'world'; immutable after create
    parent?: NodeId; // default NO_NODE = a root of its surface

    // INHERITED by children
    position?: Vec3Like; // LOCAL to parent
    visible?: boolean;

    // NOT inherited — stop at this node (§5)
    rotation?: number; // degrees, CCW-positive
    scale?: Vec3Like; // per-axis, default 1; negative x = horizontal flip
    alpha?: number; // 0..1
    tint?: number;

    anchor?: Vec3Like; // 0..1 pivot INSIDE this node's own art — not hierarchy
    layer?: number; // draw order in surface; sibling order when parented
    neverCull?: boolean; // visual exceeds bounds — glow, stroke, emitter
    uiAnchor?: UiAnchor; // UI-surface roots only; `position` is the offset from it
}

export interface SpriteNodeDesc extends NodeBase {
    kind: 'sprite';
    texture: string;
}
export interface GroupNodeDesc extends NodeBase {
    kind: 'group';
} // pivot only; art-less
export interface TextNodeDesc extends NodeBase {
    // UI surfaces ONLY
    kind: 'text';
    text: string;
    style?: TextStyle;
}
export type NodeDesc = SpriteNodeDesc | GroupNodeDesc | TextNodeDesc;

export interface NodePatch {
    id: NodeId;
    parent?: NodeId;
    position?: Vec3Like;
    rotation?: number;
    scale?: Vec3Like;
    anchor?: Vec3Like;
    alpha?: number;
    visible?: boolean;
    tint?: number;
    layer?: number;
    texture?: string; // sprite nodes only
    text?: string; // UI text nodes only
}

export interface Transform {
    position: Vec3;
    rotation: number;
    scale: Vec3;
    alpha: number;
    visible: boolean;
}

// ─── events ─────────────────────────────────────────────────────────
export interface RendererEvents {
    contextlost: { reason: string };
    contextrestored: { reloadedAssets: string[]; failedAssets: string[] };
    resize: { canvas: Size; stage: Bounds; viewport: Bounds; resolution: number };
}

// ─── the interface ──────────────────────────────────────────────────
export interface IRenderer {
    readonly initialized: boolean;
    readonly contextState: ContextState;
    readonly pendingAssetOps: number; // observability during a loss

    init(options: RendererInitOptions): Promise<void>;
    destroy(): void;

    // sizing
    resize(cssWidth: number, cssHeight: number): void;
    readonly canvasSize: Readonly<Size>;
    readonly resolution: number; // DPR actually in use
    readonly stageRect: Readonly<Bounds>; // letterboxed stage, screen space
    readonly viewport: Bounds; // world space, y-up  ->  camera.viewport

    // surfaces
    setSurfaceVisible(surface: Surface, visible: boolean): void;
    isSurfaceEnabled(surface: Surface): boolean;

    // assets — async, uniform AssetInfo; queued while the context is lost
    loadAsset(entry: AssetManifestEntry): Promise<AssetInfo>;
    loadAssets(entries: readonly AssetManifestEntry[]): Promise<AssetLoadResult>;
    unloadAssets(entries: readonly (string | AssetManifestEntry)[]): Promise<AssetUnloadResult>;
    createTextAsset(name: string, text: string, style?: TextStyle): Promise<AssetInfo>;
    hasAsset(name: string): boolean; // INTENDED state, post-queue
    getAssetSize(name: string): Readonly<Size> | null;

    // nodes — store ops; always immediate, even during a context loss
    createNode(desc: NodeDesc): NodeId; // sync — see §9.1
    createNodes(descs: readonly NodeDesc[], out?: NodeId[]): NodeId[];
    createNodeAsync(desc: NodeDesc): Promise<{ id: NodeId } & AssetInfo>;
    destroyNode(id: NodeId): void; // cascades to children
    destroyNodes(ids: readonly NodeId[]): void;
    updateNodes(patches: readonly NodePatch[]): void;
    updateSubtree(
        root: NodeId,
        patch: Omit<NodePatch, 'id' | 'parent'>,
        opts?: { includeRoot?: boolean },
    ): void; // set-only
    setNodeText(id: NodeId, text: string): void; // UI text nodes only
    isAlive(id: NodeId): boolean;
    clear(surface?: Surface): void; // drop nodes; keep canvas and assets

    // hierarchy — position + visibility only
    attachNode(child: NodeId, parent: NodeId, opts?: { keepResolvedPosition?: boolean }): void;
    detachNode(child: NodeId, opts?: { keepResolvedPosition?: boolean }): void;
    parentOf(id: NodeId): NodeId; // NO_NODE when a root
    childrenOf(id: NodeId, out?: NodeId[]): NodeId[];
    surfaceOf(id: NodeId): Surface | null;

    // camera — shared by the three camera-transformed surfaces
    setCamera(camera: Readonly<CameraState>): void;
    readonly camera: Readonly<CameraState>;

    // transforms & bounds — our store answers, never Pixi
    localTransformOf(id: NodeId, out?: Transform): Transform | null;
    resolvedTransformOf(id: NodeId, out?: Transform): Transform | null;
    localBoundsOf(id: NodeId): Bounds | null;
    worldBoundsOf(id: NodeId): Bounds | null; // rotated AABB — culling + editor selection
    screenBoundsOf(id: NodeId): Bounds | null; // UI hit-testing (§12.4)
    screenPositionOf(id: NodeId, out?: Vec3): Vec3 | null;
    worldToScreen(point: Vec3Like, out?: Vec3): Vec3;
    screenToWorld(point: Vec3Like, out?: Vec3): Vec3;

    on<K extends keyof RendererEvents>(
        event: K,
        handler: (e: RendererEvents[K]) => void,
    ): () => void; // unsubscribe, matching api_spec.ts:264

    render(): void; // no dt — the renderer owns no clock
}
```

### 11.1 Contracts not visible in the signatures

- **`IRenderer` is an interface with per-backend factories** (`createPixiRenderer()`), not an abstract
  class: no inheritance coupling, no runtime import needed to get the type, and mocks are one object
  literal.
- **`updateNodes` retains nothing** past the call — not the array, not any patch object. Callers may keep a
  pooled `NodePatch[]`, refill it each frame, and hit zero allocation, while the signature stays readable.
  Struct-of-arrays with a field bitmask would be marginally faster and considerably worse to maintain at
  Grove's scale (hundreds of entities, not hundreds of thousands).
- `undefined` field in a patch = unchanged. `texture` on a text node is ignored with a dev warning.
- **`attachNode` reinterprets, `detachNode` preserves.** `keepResolvedPosition` defaults to `false` on
  attach and `true` on detach — matching api_spec.ts:204-205, where `attachTo` says "position becomes local
  to parent" and `detach` says "keeps world position." Matching the creator API is worth more than internal
  symmetry, and the option overrides either way.
- **`layer` on a parented node is sibling order**, not a global layer. A child cannot escape its parent's
  layer — that is what a hierarchy means. Roots use `layer` as the surface-wide ordinal.
- **Within a layer, order is insertion-defined and stable** — one fewer source of visual nondeterminism.
- **`destroyNode` cascades**, matching `Entity.destroy()` (api_spec.ts:250). Children's handles are
  invalidated too.
- **`createNodes` has no intra-batch parenting** — a `parent` must already exist. Create parents with
  `createNode`, children in a batch.
- **`'group'` nodes** exist because explicit hierarchy needs a transform with no art, matching "empty group
  nodes are entities without one" (api_design.md:225).
- **`render()` owns no clock.** No clip playback, no time-based re-rasterization, no internal tweening.
  Frame animation is the client picking a texture name per frame and pushing it through `updateNodes` —
  animation state is game state.

---

### 11.2 `inspect()` — the one method for tooling

`inspect(opts?)` returns a `SceneSnapshot`: roots per surface in draw order, every live node keyed by
id, and the view state (camera, canvas, viewport, stage, resolution, context, assets).

**Why it is on the interface, when `isCulled` and `drawOrderOf` are deliberately test-only.** Those
two answer questions a caller already has another way to ask. Enumeration is different: every
per-node query — `parentOf`, `childrenOf`, `surfaceOf` — walks DOWN from a handle the caller already
holds, so nothing outside the renderer can discover a surface's roots. A tool that cannot enumerate
cannot show a node whose handle its caller lost, which is the bug class an inspector is worth having
for. Both backends answer from `RendererCore`, so the wider contract costs a one-line delegation.

**It is a snapshot, not a view.** Every field is copied — transforms, bounds, the camera. The core
computes bounds through reused scratch rects, so handing those out would alias every node onto the
last one's extent; a 16×16 sprite would report the 200×200 sprite's bounds. The contract suite
asserts distinct objects AND distinct values, using two differently sized textures, because
equal-sized ones pass either way.

**It allocates, on purpose, and is therefore dev/tooling only.** One object per node per call. Never
call it per frame in a shipped game, and never branch game logic on it — the narrow queries exist
for that. `skipBounds: true` drops the per-node size lookup when only the hierarchy matters, and
`surface` restricts the walk.

Returns an empty snapshot before `init` and after `destroy` rather than `null`, so an inspector panel
that mounts early needs no guard.

---

## 12. Usage

```ts
import type { IRenderer } from '@platform/renderer';
import { createPixiRenderer } from '@platform/renderer/pixi';

const renderer: IRenderer = createPixiRenderer();
await renderer.init({
    container: document.getElementById('stage')!,
    design: { width: 960, height: 540 },
    enabledSurfaces: ['world', 'ui'], // editor passes all five
});

await renderer.loadAssets([
    { name: 'hero', kind: 'image', url: '/assets/hero.png' },
    { name: 'tiles', kind: 'atlas', url: '/assets/tiles.json' },
]);

const hero = renderer.createNode({
    kind: 'sprite',
    texture: 'hero',
    surface: 'world',
    position: { x: 0, y: 0 },
    layer: 10,
});

// a nameplate that follows the hero's position but never its spin or fade
const plate = renderer.createNode({
    kind: 'sprite',
    texture: 'nameplate',
    surface: 'world',
    parent: hero,
    position: { x: 0, y: 40 },
});

// per frame, from @platform/client
renderer.updateNodes([{ id: hero, position: { x, y }, rotation: deg }]);
renderer.setCamera({ position: { x: camX, y: camY, z: 0 }, zoom: 1 });
renderer.render();

// teardown
renderer.destroyNode(hero); // cascades to `plate`
renderer.clear('world');
renderer.destroy();
```

Two things easy to miss: **world text goes through `createTextAsset` first**, then becomes a sprite node
(`kind: 'text'` is UI-only — §9.3); and **`render()` is explicit** — nothing draws until you call it.

---

## 13. Package layout

```
packages/renderer/
├── package.json          + pixi.js; exports "." / "./pixi" / "./null"
├── tsconfig.json         + "lib": ["ES2023", "DOM", "DOM.Iterable"]
├── src/
│   ├── index.ts              public barrel — types + IRenderer, NO pixi import
│   ├── renderer.ts           IRenderer, options, descs, patches, events
│   ├── node-id.ts            NodeId brand, pack/unpack, NO_NODE
│   ├── errors.ts             RendererError + codes
│   ├── surfaces.ts           PURE: surface order, camera-transformed predicate
│   ├── viewport.ts           PURE: framing + scaleMode -> fitScale, viewport, stageRect
│   ├── projection.ts         PURE: world<->screen, y-flip, deg->rad, UI anchors
│   ├── transform-store.ts    PURE: SoA graph, position/visible resolve, dirty
│   ├── bounds.ts             PURE: local bounds, rotated AABB, cull test
│   ├── node-store.ts         PURE: slot table, freelist, generations
│   ├── asset-queue.ts        PURE: per-name intent map, manifest merge
│   ├── core/                 PURE: everything both backends share (added — see below)
│   │   ├── renderer-core.ts      stores, validation, hierarchy, resolve/cull, projection
│   │   └── scene-sink.ts         the seam a backend implements
│   ├── null/                 headless IRenderer — tests, server, CI
│   └── pixi/
│       ├── index.ts              createPixiRenderer()
│       ├── pixi-renderer.ts      orchestration only
│       ├── pixi-sink.ts          SceneSink impl — the only file touching xform/art pairs
│       ├── asset-registry.ts     name -> Texture; atlas expansion; retention
│       ├── text-raster.ts        text assets — 2D canvas, no WebGL
│       ├── surface-tree.ts       5 surface roots, layer containers
│       ├── node-tree.ts          xform/art pairs, reparent, cascade
│       ├── flush.ts              dirty store -> local writes + cull toggles
│       ├── context-guard.ts      loss/restore, preventDefault, rebuild
│       └── text-style.ts         TextStyle -> Pixi TextStyle
└── tests/
    ├── contract/renderer-contract.ts    reusable suite, any IRenderer
    ├── node-id.test.ts        node-store.test.ts
    ├── transform-store.test.ts          position-only inherit, dirty scope, cascade
    ├── bounds.test.ts                   rotated AABB, anchor offset, world-px margin
    ├── asset-queue.test.ts              coalescing, manifest merge, unload-wins
    ├── projection.test.ts               round-trips, y-flip, UI anchors, framing
    ├── viewport.test.ts
    └── null-renderer.test.ts
```

**Subpath exports matter.** Importing `@platform/renderer` must yield the interface and types without
pulling `pixi.js` into the module graph — otherwise anything touching the type (server-side tooling, the
panel's type emission) drags a WebGL library along.

**`core/` was added during implementation.** This document specified two backends behind one interface
but never said how to factor the code between them, and implementing each independently produced heavy
duplication: 15 methods byte-identical across the two, `createNode`'s entire validation block copied,
and a dozen more methods at 72–98% similarity. Because the contract suite runs against only one backend
(§15), a divergence would not have been caught — and one had already appeared, with the two backends
disagreeing on whether surface visibility affects a node's cull flag.

`RendererCore` now owns everything backend-independent, and a backend supplies a `SceneSink`:
create/reparent/destroy a node's objects, push its local values, toggle its art, report its size, apply
the view. So the semantics the suite asserts — validation order, the attach/detach asymmetry (§11.1),
`updateSubtree`'s set-only fan-out (§5.1), the resolve/flush/cull pass (§6.1, §8) — exist in exactly one
place, and the suite's coverage protects both backends rather than only the headless one. What stays
per-backend is what genuinely differs: `init`, `resize`, the asset pipeline, the context guard, and text
measurement.

---

## 14. Config changes required

1. **`@platform/math` gains `src/vec3.ts` and `src/bounds.ts`** plus barrel exports (§2). Renderer already
   declares the dependency and the project reference — only new files.
2. **`@platform/engine` re-exports `Vec3` / `Vec3Like` / `Bounds`** from math, so the creator-facing name in
   `api_spec.ts` resolves to one type.
3. **`lib` gains `DOM`, `DOM.Iterable`** in `packages/renderer/tsconfig.json`. `tsconfig.base.json` is
   `["ES2023"]`, so `HTMLElement` / `ResizeObserver` / `WebGLContextEvent` / `OffscreenCanvas` will not
   resolve. Per-package override, **not** a base change.
4. **Add `pixi.js` v8** to `packages/renderer` dependencies. `Application.init()` being async is the
   concrete reason `IRenderer.init` returns a promise.
5. **Subpath exports** in `packages/renderer/package.json` (`.`, `./pixi`, `./null`) with matching `dist/**`
   paths.
6. `NodeNext` + `verbatimModuleSyntax`: explicit `.js` on every relative import, `import type` where
   type-only. `.oxlintrc.json` enforces `typescript/consistent-type-imports` and `import/no-cycle`.

---

## 15. Testing

The interesting move is a **contract suite** — `runRendererContract(() => createNullRenderer())` — covering
handle lifecycle, stale-handle no-ops, freelist reuse, position-only inheritance, destroy cascade, layer
reordering, camera/viewport math, and transform round-trips. Today it runs against `NullRenderer`; when a
browser-mode vitest target exists it runs unchanged against `PixiRenderer`; if a Three backend appears it is
the acceptance test.

**Pixi itself will not be unit-tested in MVP** — there is no WebGL in Node. The mitigation is
architectural: every piece of arithmetic lives in a pure module with no DOM import, and `pixi-renderer.ts`
stays thin delegation. The two things Pixi could get wrong silently are named browser-mode tests rather
than assumptions:

1. **Dual-composition agreement** (§6.5) — our resolved position vs. Pixi's `getGlobalPosition`.
2. **`preventDefault()` on `webglcontextlost`** (§10) — without it, restore never fires.

Named unit tests for the three highest-risk pieces of arithmetic: packed-id generation overflow (§7,
must not use `<<`), the y-flip round-trip (§6.3), and the rotated-AABB expansion (§8).

---

## 16. Build order

1. `vec3.ts` / `bounds.ts` in `@platform/math`; `node-id.ts`, `errors.ts`, `node-store.ts` + tests
2. **`transform-store.ts` + tests** — position-only inheritance, dirty scope, destroy cascade. Zero DOM,
   highest-risk logic.
3. `bounds.ts`, `projection.ts`, `viewport.ts`, `surfaces.ts` + tests — all sign-bearing math
4. `asset-queue.ts` + tests — coalescing and manifest merge, pure
5. `renderer.ts` — the interface
6. `null/` + contract suite — validates the interface against a second implementation **before** Pixi exists
7. `pixi/` — asset registry, text raster, surface tree, node tree, flush, context guard, orchestrator
8. Config, exports, README

Steps 1–6 need no browser at all, which means the interface gets validated against a second implementation
before we commit to the first.

---

## 17. 3D readiness

**Holds unchanged:** string-named assets, packed handles, surfaces, layers, `TextStyle`, `setCamera`,
`loadAssets`, the whole lifecycle, `render()`, the batching contract, and — most importantly —
position-only inheritance, which composes identically in 3D (vector addition, no matrix). `z` is
present-but-reserved from day one per §2, and per-axis `scale` is already 3D-shaped.

**Would need to change:** `rotation: number` is a single view-axis angle, so a 3D backend widens it with
optional `rotationX/Y/Z`; `anchor` is a 2D billboard concept; `ScaleMode`/`Framing` are 2D framing where 3D
wants FOV; `worldToScreen`'s `z` would carry depth.

Contained: additive optional fields plus one alternate camera shape. Nothing in the interface names a Pixi
type, so a swap is a new folder under `src/`.

One item slightly _reduced_ readiness: nesting the Pixi tree (§6.2) means we depend on the backend
composing a nested tree the way we do. True of Three, but it is one more contract than the flat-write
alternative.

---

## 18. Open questions

**All five resolved as implemented, each keeping this document's stated default:** `createNode` is
synchronous, `Bounds` stays `{left, right, top, bottom}`, UI is design px scaled by `fitScale`,
visibility inherits, and atlas frames use bare names (a cross-sheet collision is reported rather than
silently resolved). Any of them can still be revisited — the notes below are why each default was
chosen — but nothing is blocked on them.

**Four things this document did not specify, settled during implementation:**

- **Letterboxing is effective only under `framing: 'stage'` AND `scaleMode: 'fit'` AND
  `letterbox !== false`.** §4.1 lists `letterbox` as independent and defaulting to true, but under
  `expand` a design-sized stage plus bars would bar the extra area — the opposite of §4.2's "bigger
  screens see more world". Under `fill`/`expand` world content owns the full canvas. `isLetterboxed()`
  encodes this.
- **Letterbox clipping covers `editorSpace`, `world` and `ui` only** — never the editor chrome, which a
  bar would cut off. `isClippedWhenLetterboxed()` encodes this.
- **`anchor` defaults to `{x: 0.5, y: 0.5}`.** §5 calls negative-x flip the common case and a flip
  pivots about the anchor: centered flips in place, top-left flips across the origin. Differs from raw
  Pixi's `(0, 0)`, so `art.anchor` is set explicitly on every sprite.
- **`createNode` on a surface absent from `enabledSurfaces` throws `RendererError('surface-disabled')`**,
  following §7's split: races no-op, caller bugs throw.

The original notes, for the record:

1. **`createNode` sync or async?** Currently sync (§9.1), because `scene.spawn` is specified synchronous
   and always safe and the engine needs the handle immediately; `createNodeAsync` covers size-needing
   callers. Making `createNode` async means the engine gets a pending-id table or `scene.spawn` becomes
   async — a spec change.
2. **`Bounds` orientation.** api_spec.ts:48 still carries `// TODO: bound in world or entity space?`.
   Default: keep `{left, right, top, bottom}` with `top > bottom` under y-up. `{x, y, width, height}`
   sidesteps the orientation trap and reads better for a creator, but diverges from the spec as written.
   Touches `worldBoundsOf`, `localBoundsOf`, `screenBoundsOf`, `stageRect`, `viewport`.
3. **UI space units.** Design px scaled by `fitScale` (current choice — a panel-authored HUD is
   pixel-identical everywhere) vs. raw CSS px (HUD text always crisp). One-way door for panel authoring.
4. **Does visibility inherit?** Currently yes (§5), free via `xform.visible`. If visibility should also stop
   at one node, it costs a per-node `resolvedVisible` computation rather than a free container flag.
5. **Atlas frame naming.** Bare sheet frame names with a cross-sheet uniqueness check (current default,
   since the panel authors the manifest and can guarantee uniqueness), or namespaced `atlas/frame`?
   Depends on what the panel emits.
