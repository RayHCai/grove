# @platform/math

Pure, dependency-free primitives: vectors, bounds, easing, scalar helpers, seeded random,
deterministic transcendentals, generation-packed handles, the slot table behind them, and
typed-array growth.

The leaf of the package graph — it depends on nothing, and every other package may depend on it.
Determinism is a property of arithmetic, so isolating the arithmetic means the
determinism-critical surface is a package a reader can hold in their head, and one that needs
no world, no clock, and no network.

The creator-facing import is unaffected: `clamp` and `Vec3` are reached from `@platform/engine`
like the rest of the API, which re-exports them from here so each name resolves to one type. The
storage primitives — handles, `SlotTable`, the growth helpers, the `numeric.ts` guards, `defined` —
are engine-internal and are deliberately not part of that re-export.

## What's here

```ts
import { clamp, lerp, vec3, boundsOverlap, DEG2RAD, SlotTable } from '@platform/math';
import type { Vec3, Vec3Like, Bounds, Size } from '@platform/math';
```

| Module                  | Exports                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vec3.ts`               | `Vec3`, `MutableVec3`, `Vec3Like`, `vec3`, `vec3Set`, `vec3Copy`, `vec3Length`, `vec3LengthSq`, `vec3Dist2D`, `vec3Normalize`                          |
| `bounds.ts`             | `Bounds`, `Size`, `bounds`, `boundsSet`, `boundsCopy`, `boundsWidth`, `boundsHeight`, `boundsEqual`, `boundsOverlap`, `boundsContains`, `boundsExpand` |
| `scalar.ts`             | `DEG2RAD`, `RAD2DEG`, `clamp`, `lerp`, `approach`                                                                                                      |
| `numeric.ts`            | `finiteOr`, `isFiniteNumber`, `positiveOr`                                                                                                             |
| `optional.ts`           | `defined`                                                                                                                                              |
| `easing.ts`             | `Easing`, `ease`                                                                                                                                       |
| `random.ts`             | `SeededRandom`                                                                                                                                         |
| `deterministic-math.ts` | `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, the hyperbolics, `exp`, `expm1`, `log`, `log1p`, `log2`, `log10`, `pow`, `cbrt`, `hypot`         |
| `handle.ts`             | `INDEX_RANGE`, `MAX_INDEX`, `MAX_GENERATION`, `FIRST_GENERATION`, `packHandle`, `handleIndex`, `handleGeneration`, `nextGeneration`                    |
| `slot-table.ts`         | `SlotTable`, `SlotTableSnapshot`                                                                                                                       |
| `typed-array.ts`        | `growF64`, `growI32`, `growU8`, `grownCapacity`                                                                                                        |

The 22 transcendentals are an enforcement allowlist as much as an implementation — `.oxlintrc.json`
refuses each matching `Math.*` property and names the replacement (`Math.random` among them, in
favour of `SeededRandom`), and `@platform/engine` re-exports the same 22 — so renaming or dropping
one is a cross-package change.

Handles are packed arithmetically as `generation * 2^24 + index`, because `<<` coerces to int32
and would start minting negative, colliding handles at generation 128. Releasing a slot bumps its
generation and pushes the slot onto a freelist, so a handle that outlived its record reads as
absent rather than as whatever record reused the slot; a slot that reaches `MAX_GENERATION` is
retired instead of pushed, because reuse past the generation wrap would reissue a handle it has
already given out.

## Conventions worth knowing

**`Vec3` vs `Vec3Like`.** `Vec3` requires all three axes and is what every function _returns_;
`Vec3Like` permits an omitted `z` and is what every _parameter_ accepts, so a caller writes
`{x: 10, y: 5}` and `z` defaults to 0. Without the split every call site pads `z: 0` by hand.

**`z` counts everywhere except where the name says it does not.** `vec3Length`, `vec3LengthSq`
and `vec3Normalize` all fold `z` in; `vec3Dist2D` is the one function that drops it, and carries
that in its name so a reader coming from `vec3Length` cannot mistake the two.

**`Bounds` is orientation-agnostic.** The edge names are read in the space that produced them:
world space is y-up so `top > bottom`, screen space is y-down so `bottom > top`. Nothing here
assumes a direction — `boundsWidth`/`boundsHeight` return absolute extents, `boundsOverlap`
compares each axis against its own min/max, and `boundsExpand` grows each edge away from the
interior. That is what lets one set of helpers serve both spaces.

**`Bounds` is mutable where `Vec3` is readonly.** `Vec3` splits into a readonly creator-facing type
and a `MutableVec3` the out-params write through; `Bounds` does not, because `docs/api_spec.ts`
declares the creator-facing rectangle with writable edges and the spec is authoritative. The cost
is that a creator holding a `Bounds` can write to it, so a getter that returns one must return a
copy rather than the live object.

**`out` comes first, and is mandatory.** Every helper whose result _is_ the object it writes —
`vec3Set`, `vec3Copy`, `vec3Normalize`, `boundsSet`, `boundsCopy`, `boundsExpand` — takes `out` as
its first parameter and returns it, allocating nothing, so a per-frame caller can hit zero
allocation. There is no defaulted `out`: a caller that wants a fresh object writes
`boundsExpand(bounds(), b, margin)` and the allocation is visible at the call site. `SlotTable`'s
`liveIds`/`liveIndices` are the deliberate exception — they return a collection rather than a
single value, so the buffer is an optional trailing argument.
