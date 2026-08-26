# @platform/project

The authoring shape: the manifest an editor saves for one game, the validator that admits a file,
the format migrations that move an older one forward, and the two narrowings every runtime input is
derived from.

One game is one `ProjectManifest`. It holds the placed world directly — there is no scene between
the game and its entities, because Game **is** the world: it owns the entities, holds the build-time
bounds and scopes spawn and find (api_design.md §3.4). The field is therefore `entities`, never
`scenes`.

Its only dependency is a **type-only** `JsonValue` from `@platform/transport`, the same treatment
`@platform/protocol` gives that type. That is what lets `core`, `protocol`, `server`, `client` and
`engine` each take the authoring types without taking a module graph with them, and it is why math's
`Bounds` is restated here as `ProjectBounds` rather than imported.

## What's here

```ts
import { validate, migrate, toGameManifest, toRenderManifest } from '@platform/project';
import type { ProjectManifest, TemplateId, ScriptId, AssetId } from '@platform/project';

const project = validate(migrate(JSON.parse(text)));
```

| Module        | Exports                                                                                                                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ids.ts`      | `TemplateId`, `ScriptId`, `AssetId`, and the three mint calls                                                                                                                                                                                                  |
| `props.ts`    | `ScriptProps` — what an inspector configured one attachment with, `JsonValue`-constrained because it is saved                                                                                                                                                  |
| `manifest.ts` | `PROJECT_FORMAT_VERSION`, `ProjectManifest`, `ProjectSettings`, `EntityRecord`, `TemplateRecord`, `TemplateChildRecord`, `AssetRecord`, `ScriptModule`, `ScriptDecl`, `ScriptAttachment`, `TemplateVisual`, `EntityTransform`, `ProjectBounds`, `RegionRecord` |
| `validate.ts` | `validate`, `ProjectFormatError`                                                                                                                                                                                                                               |
| `migrate.ts`  | `migrate`, `MIGRATIONS`, `Migration`, `MigrationChain`                                                                                                                                                                                                         |
| `adapters.ts` | `toGameManifest`, `toRenderManifest`, `GameManifest`, `RenderManifest`, `ResolvedTemplate`, `ResolvedAttachment`, `PlacedEntity`, `ScriptResolver`, `ScriptClass`                                                                                              |

## Three ids that survive a save, and two handles that do not

`TemplateId`, `ScriptId` and `AssetId` are branded strings, each with its own `unique symbol`. That
makes them mutually unassignable both with each other and with the two runtime handles they are
easiest to confuse with — core's `EntityId` and protocol's `NetId`, which are generation-packed
numbers meaningless outside the runtime that minted them. An authoring id is the opposite: it is
written into a file, read back next session, and names the same thing across every rebuild of the
world.

A placed entity's own `id` is deliberately **unbranded**. It addresses a row of `entities` in the
same file and nothing else, so there is no second minting authority to keep it apart from — the
alias exists so the two fields that hold one say so.

## Migrate, then validate

The two are separate calls because they answer different questions, and only one of them rewrites.

- `migrate` walks a parsed file forward one `formatVersion` at a time to the chain's target, and
  stamps each new version itself so no step can forget to. A file **above** the target is refused.
  That is the opposite of `PROTOCOL_VERSION`, which refuses a mismatch in either direction: a peer
  can be told to update and a file on disk cannot.
- `validate` requires the current `formatVersion` and then checks the shape, refusing rather than
  repairing and returning the value it was handed. Beyond the field types it closes the references a
  type cannot: every id is unique, a template's texture names a real asset, an entity's template
  names a real template, an attachment names a declared script whose host matches the site it is
  attached to, and a parent's record comes **before** its children's — so a loader builds the
  hierarchy in one pass.

    A template's `children` is the one reference that is deliberately unordered: a child names a
    template, which may be declared further down the array, so the ids are collected first and the
    graph closed afterwards. That graph is then walked per template against the path it is on, which
    refuses a template that reaches itself and one nesting past eight levels — both being the same
    fault, an instantiation that mints entities until memory stops it — while leaving a diamond, where
    two children name one leaf template, perfectly legal.

`validate` is the trust boundary and the server calls it. Core only ever receives the already-valid
type, which is what keeps this package out of core's runtime import path.

## The two narrowings

One authoring asset entry has to span three vocabularies: core's six kinds keyed by `key`, the
renderer's four keyed by `name`, and protocol's restatement of core's. The authoring vocabulary is
the six, and the adapters are where the narrowing happens.

| Adapter                   | Produces                                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toGameManifest(p, opts)` | what builds a world: role, `simRate`, bounds, regions, assets **without** their urls, the templates, the placed entities, and every attachment's class beside its id |
| `toRenderManifest(p)`     | what draws one: assets **with** their urls, and one visual per template keyed by its spawn key                                                                       |

A runtime loads nothing, so it holds no address it could act on; a client fetches, so it needs the
url. `toGameManifest` takes a `ScriptResolver` because a manifest holds ids and a runtime wires
classes — the only layer that can bridge the two is the one that already holds the game's code. It
keeps the id alongside the resolved class rather than replacing it: a runtime constructs the class,
and the wire names the id, since a minified class name is no contract across a process boundary.
