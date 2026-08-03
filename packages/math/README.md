# @platform/math

Pure math: vectors, bounds, easing, scalar helpers, seeded random. No dependencies.

The leaf of the package graph — it depends on nothing, and every other package may depend on it.
Determinism is a property of arithmetic, so isolating the arithmetic means the
determinism-critical surface is a package a reader can hold in their head, and one whose tests
need no world, no clock, and no network (api_design.md §11.1).

The creator-facing import is unaffected: `clamp` and `Vec3` are reached from `@platform/engine`
like the rest of the API, which re-exports them from here so each name resolves to one type.

## What's here today

```ts
import { clamp, lerp, vec3, boundsOverlap, DEG2RAD } from '@platform/math';
import type { Vec3, Vec3Like, Bounds, Size } from '@platform/math';
```

| Module      | Exports                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vec3.ts`   | `Vec3`, `Vec3Like`, `vec3`, `vec3Set`, `vec3Copy`, `vec3Z`                                                                                            |
| `bounds.ts` | `Bounds`, `Size`, `bounds`, `boundsSet`, `boundsCopy`, `boundsWidth`, `boundsHeight`, `boundsOverlap`, `boundsContains`, `boundsExpand`, `boundsSize` |
| `scalar.ts` | `DEG2RAD`, `RAD2DEG`, `clamp`, `lerp`                                                                                                                 |

Still to come, per api_design.md §11.1: `approach`, the `Easing` curves, and the seeded
generator (`seed`, `between`, `pick`, `chance`).

## Two conventions worth knowing

**`Vec3` vs `Vec3Like`.** `Vec3` requires all three axes and is what every function _returns_;
`Vec3Like` permits an omitted `z` and is what every _parameter_ accepts, so a caller writes
`{x: 10, y: 5}` and `z` defaults to 0. Without the split every call site pads `z: 0` by hand.

**`Bounds` is orientation-agnostic.** The edge names are read in the space that produced them:
world space is y-up so `top > bottom`, screen space is y-down so `bottom > top`. Nothing here
assumes a direction — `boundsWidth`/`boundsHeight` return absolute extents, `boundsOverlap`
compares each axis against its own min/max, and `boundsExpand` grows each edge away from the
interior. That is what lets one set of helpers serve both spaces.

The `out`-parameter helpers (`vec3Set`, `boundsSet`, …) return the object they were handed and
allocate nothing, so a per-frame caller can hit zero allocation.
