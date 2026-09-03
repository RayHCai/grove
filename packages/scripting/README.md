# @platform/scripting

Script policy and toolchain: it turns a project's creator scripts into one deterministic,
content-hashed ESM chunk per side, refuses the things a `SyncedScript` may not run, and resolves a
script id back to a constructor at run time.

This is policy and build, not runtime — which is why it is not part of `@platform/core`. Core owns
the script model itself: the four bases, the sixteen handler decorators and `@serverState`, the
per-class metadata registry, and dispatch. Nothing in core depends on this package, and nothing here
reimplements any of it.

## The constraint the pipeline is shaped by

Core's scripts are written with **TC39 standard decorators**, and `tsc` is the only tool in this
repo that lowers them. A bundler run over the source emits them verbatim, the runtime then refuses
to parse the file, and the metadata tables the whole chunk exists to carry come out empty. The order
is therefore fixed:

```
analyse source  ->  refuse  ->  tsc lowers  ->  rolldown links
```

The refusal comes before the compiler so a diagnostic points at the creator's own line. The linker
runs after it so it only ever sees lowered output. `apps/playground`'s `tsconfig.server.json` and
`packages/server`'s decorated fixtures are the same split, done by hand.

## Two entry points

| Import                          | Runs where                 | Holds                                                 |
| ------------------------------- | -------------------------- | ----------------------------------------------------- |
| `@platform/scripting`           | anywhere, browser included | `ScriptRegistry`, the determinism policy, the shim    |
| `@platform/scripting/toolchain` | Node, at build time        | the analysis, the determinism pass, `tsc`, the linker |

The split is the point: a browser bundle that reaches the registry must not pull a compiler and a
bundler into its module graph.

## Building a bundle

```ts
import { buildScriptBundle } from '@platform/scripting/toolchain';

const bundle = await buildScriptBundle({
    tsconfig: 'game/tsconfig.json', // its rootDir must be srcDir, and its lib must carry ESNext.Decorators
    srcDir: 'game/src',
    loweredDir: 'game/.lowered',
    outDir: 'game/dist/scripts',
});
```

Out comes a `server` and a `client` chunk, each with its own `code`, `hash`, `fileName` and the bare
specifiers it still imports. `scripts` names every class that reached a chunk. Passing `scripts` in
supplies the ids from a manifest; omitting it takes every exported script class as
`<module>#<Export>`.

**Ids are stamped here, never read off `klass.name`** — a minifier renames the class, and the wire
carries the id across a process boundary where the name is no contract.

**One chunk per side, and `synced` reaches both.** A `ServerScript` never appears in the client
chunk and a `ClientScript` never appears in the server's; a `SyncedScript` is in both, because both
ends run it.

**Two hashes, and only one of them is a correctness mechanism.** Each chunk's `hash` names its file.
`syncedHash` is the SHA-256 of the synced classes linked on their own, and it is what a handshake
compares: the two side chunks differ by construction, so comparing those would always disagree,
while prediction is unsound exactly when the two ends run different `SyncedScript` bytes.

Determinism of the emitted bytes is engineered, not assumed: the generated entry module lists
imports in id order, rolldown runs with its cwd at the lowered root so a module comment carries a
relative path rather than someone's home directory, and the text is folded to LF and POSIX
separators before it is hashed. The same sources hash the same on any machine, through any
directory.

## What a chunk exports, and what has to resolve its imports

```ts
export const side = 'server';
export const scripts = [{ id: 'rules', location: 'server', ctor: Rules }];
```

The chunk keeps `@platform/engine` and `@platform/core` external, because the runtime evaluating it
already holds them and a second copy of core would be a second runtime. Resolving those specifiers
is the evaluation boundary's job — an import map in the browser, plain resolution in Node — and
`SideChunk.imports` is the list to build one from.

```ts
import { ScriptRegistry } from '@platform/scripting';

const registry = ScriptRegistry.from(chunk.scripts);
registry.resolve('rules'); //  the class
registry.idOf(Rules); //  'rules', the edge an attach site needs to name it on the wire
registry.metadataOf('rules'); //  core's handler and @serverState tables for it
```

`metadataOf` is the join to core's decorator metadata, and it is also the assertion that the
pipeline ran in the right order: empty tables on a decorated class mean the decorators reached the
chunk unlowered. The id is a type parameter defaulting to `string`, so a consumer holding an
authoring id brand narrows to it — `ScriptRegistry<ScriptId>` — without this package depending on
the package that mints one.

## The determinism pass

Inside a `SyncedScript` subclass, a **build error** — not a lint warning, and not a run-time
surprise on the tick a prediction diverges:

| Refused                              | Write instead                                |
| ------------------------------------ | -------------------------------------------- |
| the 22 approximated `Math` members   | the same names from `@platform/engine`       |
| `Math.random`, `crypto`              | `random`, whose stream is core's `PRNGStore` |
| `Math` aliased, or `Math[expr]`      | the member call written out                  |
| `Date`, `performance`                | `ctx.dt`, and `sleep` / `every` / `after`    |
| `fetch`                              | `request`, declared on a `ServerScript`      |
| `window`, `document`, `navigator`, … | a `ClientScript`                             |
| `globalThis`, `process`              | the binding itself; `@platform/engine`       |
| `eval`, `Function`, `.constructor`   | the code written out                         |
| `import(expr)`                       | a static import at the top of the module     |
| `Reflect`, `Proxy`                   | the property read written out                |
| `WeakRef`, `FinalizationRegistry`    | an ordinary reference                        |

The rest of `Math` stays legal: `floor`, `abs`, `min`, `max`, `round`, `sqrt` and their kin are
exactly specified, so they already agree everywhere. `globalThis`, `Reflect`, `Proxy` and a
`.constructor` read are refused because they are how every other row would be reached without naming
it; `eval`, `Function` and `import()` because what they run is source no static pass ever read;
`WeakRef` and `FinalizationRegistry` because the collector's timing is nobody's contract; and
`process` because the browser half has none.

**This is why it cannot be an oxlint rule.** The identical `Date.now()` is a refusal in a
`SyncedScript` and correct in a `ClientScript`, and no lint config can express "only inside a
subclass of this class". Resolving that means following `extends` across the project's modules,
which is what the analysis pass does before anything else runs.

The 22 names exist in four places — here, `@platform/math`'s barrel, `@platform/engine`'s re-export
block, and `.oxlintrc.json`'s repo-wide `Math.*` pin — and they agree. A list that drifts is a
`SyncedScript` that desyncs, and nothing else in the repo would notice.

The pass is lexical. A helper a synced script calls is not inside it, and neither is
`globalThis['Da' + 'te']`.

## The shim, and who it is for

**Determinism here is enforced at build time and nowhere else.** The static pass above is the whole
mechanism: nothing in this repo evaluates a chunk in a realm of its own, so the lexical hole the
pass names — a helper a synced script calls — is not closed by anything downstream.

`installDeterminismShim({ target })` replaces the refused globals with accessors that throw, and
`Math` with one that keeps its exact members. It guards a whole **realm**, which is why nothing here
installs it: a `SideChunk` is evaluated in the page's own realm, where a `ClientScript`'s `Date` is
perfectly legal and this would break it. It is exported for an embedder that gives synced code a
realm to itself — a `vm` context or a worker — and that embedder owns both the `target` and the
`dispose()`.
