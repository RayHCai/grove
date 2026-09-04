# @platform/integration

The packages composed the way an application composes them, and the creator-facing API driven
through the games that composition makes possible.

Every other suite in this repo belongs to one package and validates it against a scripted peer:
`@platform/sim` against a recording client, `@platform/client` against a fake server,
`@platform/core` against no wire at all. This one belongs to no package. Its subject is the
composition — one authority, several browser tabs, real transports, a real renderer and real
prediction, all in one process on a clock the suite turns by hand.

That is also what makes it the only place an API claim can be settled. A method that moves an entity
on the authority and never marks a replication channel passes every unit test in `core` and is
broken in every real game; here it fails, because every assertion is made against what a CLIENT was
told.

## What is here

A **world** is one small complete game: its scripts, its manifest, and the two script registries a
split build produces. There is one per API component, because a camera test and a movement test want
different templates and different bounds, and sharing a world between them would make each suite
depend on the other's fixtures.

| Path                                                | Holds                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| `src/world.ts`                                      | `defineWorld`, and the constants and helpers every world shares           |
| `src/host.ts`                                       | A world, built and not listening                                          |
| `src/worlds/*.ts`                                   | One game per component — its scripts and the `World` they are declared in |
| `src/{globals,project,registry}.ts`, `src/scripts/` | The soak's own game, written out longhand                                 |
| `tests/harness.ts`                                  | One server, N tabs, one hand-turned clock, in a host's own order          |
| `tests/*.test.ts`                                   | One suite per world                                                       |

`defineWorld` derives the manifest AND both registries from a single script list. They otherwise
restate each other three times, and a world that declared a script in one and forgot it in another
would fail at load with a message about the manifest rather than about the mistake.

`src/` is compiled by `tsc` rather than read from source, because the scripts carry TC39 standard
decorators and the test runner's transform emits them verbatim — so a suite imports its world from
`dist/`, and `pnpm test` builds before it runs.

## How a suite drives its world

A test presses a widget; a handler on the authority performs the API call; the result is a
`@serverState` field or a transform change; the test settles a few ticks and reads it back off the
tab's own mirror. A press needs no key binding and no open screen, so one widget per verb is the
cheapest way to put a call inside a real handler — and it arrives on a genuine interaction frame,
carrying an engine-supplied player rather than one the test claimed.

Where a verb turns out to be inert or unreachable, the suite pins THAT, with the reason. Several
are: speech bubbles are dropped at the wire boundary, camera glides cut instantly, and a mirror is
built holding no assets.

## The soak

One suite is not about a component. Its driver picks from seven things a person does — open a tab,
hold a key, release it, click something, press a widget, close the tab, wait — and steps the world
one to six ticks between them. Every beat is checked: nothing threw on either end, no tab was sent
something it could not apply, no predicted avatar left the world.

The seed makes the session a replay rather than a lottery. A failure reproduces on the next run of
the same seed, and the suite pins that by running one seed twice and comparing a digest of the whole
server world — with a different seed as the guard that the digest could have differed at all.

Once the input stops, every tab must agree with the authority exactly, and when the last tab closes
the world must hold nothing but what the project placed in it.
