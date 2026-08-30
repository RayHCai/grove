# @platform/engine

Two entry points for two readers.

`@platform/engine` is the one import a creator's script sees: the runtime API `@platform/core` owns
and the primitives `@platform/math` owns, gathered so every creator-facing name in `docs/api_spec.ts`
resolves to exactly one type. `@platform/engine/host` is the app hosting a game: the two composition
roots that turn an authored project and a pipe into a running session.

The split is a module-graph decision, not a filing one. A linked script chunk keeps
`@platform/engine` as a bare specifier and resolves it at evaluation time, so anything on that path
lands in every game's graph — and the composition roots reach the whole server, the whole client and
the project validator. Same reason `@platform/client/browser` and `@platform/scripting/toolchain`
are subpaths. "Host" here is the app hosting a game, never the `Host` a script attaches to.

## The creator surface

```ts
import { SyncedScript, onCollide, game, hud, random, clamp, sin } from '@platform/engine';
import type { Ctx, Entity, Vec3, Bounds } from '@platform/engine';
```

`docs/api_spec.ts`'s `declare module '@platform/engine'` block is what this path must equal, in both
directions — an export it does not name and a name it declares that is not exported are each drift,
and the spec wins. Nothing is implemented here: script bases, decorators, the six engine-owned
objects and the data wrappers come from `@platform/core`, and `Vec3`, `Bounds`, `Easing`, `clamp`
and `lerp` from `@platform/math`.

The 22 deterministic transcendentals are re-exported from math in one block, in one order.
`@platform/math`'s barrel, `.oxlintrc.json` and `@platform/scripting`'s policy hold the same list, so
editing that block is a cross-package change. A `SyncedScript` must reach these through this import,
since `Math.sin` is a load-time error there.

The storage primitives math also owns — handles, `SlotTable`, typed-array growth, `finiteOr` — are
engine-internal and deliberately absent, as are `Vec3Like` and `Size`.

## The host surface

```ts
import { createClient, createServer } from '@platform/engine/host';
import type { ProjectManifest } from '@platform/engine/host';
```

| Export                                        | Is                                                             |
| --------------------------------------------- | -------------------------------------------------------------- |
| `createServer(project, opts?)`                | Boots the authority for a project, connected to nothing        |
| `createClient(opts)`                          | Builds a session over this machine's seams                     |
| `BundleRef`                                   | Where a joiner fetches the script chunk, and its hash          |
| `CreateServerOptions` / `CreateClientOptions` | What a host supplies that a project file cannot                |
| the `@platform/project` authoring types       | The shape of the file a host loads and hands to `createServer` |
| the `@platform/scripting` registry types      | What resolves an attachment's `ScriptId` to a class            |

Neither root starts a clock or opens a connection. `pump` and `start` are the host's — and which one
a server calls decides whether the join deadline is swept — `server.accept` is called per socket by
whoever holds the listener, and `client.start()` is separate so a lifecycle listener can be
registered before the first state change.

**`createServer` validates.** The parameter is typed, but a type is a compile-time claim and a saved
project is bytes someone wrote, so it calls `validate` before building anything. That is why the
validator is not creator API: a creator authors a project, the server checks it.

**What this owns of boot order is the inside of `createServer`:** validate, resolve the attached
classes through the registry, build the templates, instantiate the placed world — all before it
returns, so a caller cannot reach a half-assembled world through the value it gets back. It never
accepts a connection, because it has no player id to accept with and that id is what makes
`@serverState` survive a rejoin. Sequencing `accept` against the tick loop, the socket and the store
is `@platform/glue`'s, and `GameInstance` is where that sequence is written down.

**Both ends derive their identity from one manifest.** `projectId` and `contentHash` become the
`projectHash` the handshake compares, so a client built from a different file — or the same file with
different content — is refused before a `Player` is allocated, rather than diverging later.

**The script registry is passed through whole.** The wire's `attach` op names a `ScriptId` and both
runtimes resolve it, so there is one table keyed one way and the location filter lives at each attach
site, which is the only place that knows an attachment arrived at all.

## Dependencies, and which graph they are in

`@platform/core` and `@platform/math` are the creator surface, and are the only two the root barrel
reaches. `@platform/server`, `@platform/client` and `@platform/project` are runtime dependencies of
`./host` alone — `GameServer`, `GameClient`, and the validator with its three narrowings.
`@platform/scripting` is type-only: a `ScriptRegistry` is named in the roots' signatures and built by
the host, so it is not in this package's runtime graph. `@platform/transport` is named in neither
root's signature — the host holds the sockets — and is reached only by this package's test.

`@platform/renderer` is a **dev** dependency, and the distinction is the point. `createClient` takes
an `IRenderer`, but through `GameClientOptions` rather than by naming the type here — so the only
thing in this package that reaches that package is the headless renderer its test injects.

A host that mints branded ids, writes a project file, or builds a `ScriptRegistry` from a chunk's
exports imports `@platform/project` and `@platform/scripting` directly. Only their types are
re-exported here — enough to name what the roots take, not to author with.
