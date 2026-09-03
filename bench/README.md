# @platform/bench

Tick cost, bytes per tick and GC pressure, measured against the built packages.

Every other suite here asks whether the engine is correct. This one asks what it costs, and answers
in three numbers: nanoseconds per tick, bytes allocated per tick, and collections plus pause time per
simulated second. It belongs to no package — the same meters drive core's loop on its own, the
authority with its codec and fan-out, and the composed application with clients predicting against it.

## Running one

```
pnpm --filter @platform/bench bench       # timing + exact bytes
pnpm --filter @platform/bench bench:gc    # collections and pause time
pnpm --filter @platform/bench bench -- --only=core.n-sweep --quick
pnpm --filter @platform/bench bench -- --list
```

Each run writes one JSON file to `runs/`, named by instant, branch, commit and mode:
`2026-09-01T11-42-03Z__main__86960b7-dirty__alloc.json`. A file carries the commit, the branch,
whether the tree was clean, the machine, and the V8 flags the process ran under, so a number is
never separated from the build and the conditions that produced it. `runs/` is git-ignored: it is
local history, not shared state.

## The two modes are two processes

An exact byte figure and a real collection count cannot be taken in the same run, and the difference
is a V8 flag rather than an option.

| Mode    | Flags                                                           | What it measures                                     |
| ------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| `alloc` | `--expose-gc --min-semi-space-size=64 --max-semi-space-size=64` | Bytes per tick, exactly, in a collection-free window |
| `gc`    | `--expose-gc`                                                   | Scavenges, major collections and pause time          |

Under `alloc` the young generation is large enough that a window can complete without collecting, so
the `used_heap_size` delta is the bytes allocated and nothing is hidden by reuse. Under `gc` the heap
is the one a server ships with, which is the only heap whose collection counts mean anything. Running
either under the other's flags produces a plausible number that is wrong, so `assertMode` refuses it
before anything is measured.

**Both semi-space flags, not just the maximum.** V8 sizes the young generation adaptively and shrinks
it on collection, so the forced sweep that establishes each window's baseline hands that window a
young generation of a megabyte or two however high the ceiling was set. The maximum alone measured a
thousand-entity tick at 573 KB; with the minimum pinned as well, and the window verifiably
collection-free, the same tick is 8.57 MB. `assertMode` requires both.

## What the meters guarantee

| Rule                                          | Why                                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| One process per scenario                      | V8's optimisation state is a function of everything already run; see below                                                |
| Every drain turns the loop                    | A `gc` entry reaches an observer on a task; a window that blocked and drained at once reads empty                         |
| One GC observer per window                    | An observer held across a session drops entries once its buffer is exceeded, and a dropped entry reads as "no collection" |
| A window that collected is retried shorter    | A scavenge inside the window reclaims bytes the delta never sees, so its figure is a lower bound                          |
| `exact: false` is carried through to the JSON | An inexact byte figure that reads like a measurement is worse than no figure                                              |
| The allocation window is reported separately  | Shrink-to-clean makes it a different number from the timing window, and conflating them hides the shrink                  |
| Windows are sized by a probe                  | Tick cost spans four orders of magnitude here; a fixed count measures noise at one end and takes minutes at the other     |
| Every world states its overlapping pair count | Two worlds of equal size and different overlap are not comparable, and half-extents of zero compare equal                 |

## What is here

| Path                     | Holds                                                                          |
| ------------------------ | ------------------------------------------------------------------------------ |
| `src/meter.ts`           | The three meters, the driver abstraction, and the mode guard                   |
| `src/worlds.ts`          | Core-only worlds built to a spec: entity count, colliders, scripts, grid pitch |
| `src/scripts.ts`         | The script fixtures a sweep multiplies                                         |
| `src/scenarios/core.ts`  | Entity sweep, script sweep, per-pass breakdown, the role split                 |
| `src/scenarios/churn.ts` | A world that recycles slots, and one whose entity count keeps rising           |
| `src/scenarios/stack.ts` | The integration project's authority with N predicting clients on loopback      |
| `src/report.ts`          | The result record, its filename, and the terminal table                        |
| `src/stamp.ts`           | The commit, tree, machine and flags a result is only meaningful beside         |

Scenarios import their fixtures from `dist`, like every decorated class in this repo: `tsc` lowers
TC39 standard decorators and the test runner's transform does not.

## Reading a result

`nsPerTick` is machine-bound — useful for locating a cost on the machine that measured it, not for
comparing two machines. `bytesPerTick` under `alloc` is the figure worth comparing between commits,
and it is reproducible to the byte when the same scenario is compared against itself.

**Compare a scenario only against the same scenario.** V8 optimises from what a process has already
seen, and it optimises the contact walk's boxed half-extents away once it has enough samples. One
thousand-entity world measured first in its process allocates 8.5 MB a tick; the same world measured
after another has run allocates 573 KB. Both are collection-free, both are honest, and they are not
comparable. Each scenario therefore gets its own process, and within a scenario the measurements are
ordered to make the comparison it exists for — so `core.role-split`'s four rows are a set, and its
`server` row is not the same measurement as `core.n-sweep`'s thousand-entity row.

Two scenarios answer questions the others cannot. `core.pass-breakdown` prices each pass by removing
it from a live world rather than by timing them apart, because one pass can be three orders of
magnitude larger than the rest and a cross-run difference of that shape is indistinguishable from
noise. `core.role-split` runs with the contact walk stubbed out, because what `isServer` gates is
microseconds and the walk it would otherwise sit behind is milliseconds.
