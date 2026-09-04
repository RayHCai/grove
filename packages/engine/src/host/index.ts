// @platform/engine/host
// The composition roots: an authored project and the pipes it runs over in, a booted authority or a
// joinable session out.
//
// Behind a subpath for the reason `@platform/client/browser` and `@platform/scripting/toolchain`
// are: a creator's chunk resolves `@platform/engine`, and these two reach the sim, the client and
// the renderer. "Host" here is the app hosting a game, never the `Host` a script attaches to.

export { createSim } from './create-sim.js';
export type { BundleRef, CreateSimOptions } from './create-sim.js';
export { createClient } from './create-client.js';
export type { CreateClientOptions } from './create-client.js';

// The authoring shape, so a host can name what it loads and hands to `createSim`. Types only: the
// values @platform/project holds are the validator and the two narrowings, and `createSim` is the
// one caller that needs them — a host that mints ids or writes a file imports that package.
export type {
    AssetId,
    AssetKind,
    AssetMeta,
    AssetRecord,
    EntityRecord,
    EntityRecordId,
    EntityTransform,
    GroupVisual,
    ProjectBounds,
    ProjectManifest,
    ProjectSettings,
    RegionRecord,
    ScriptAttachment,
    ScriptDecl,
    ScriptHost,
    ScriptId,
    ScriptLocation,
    ScriptModule,
    ScriptProps,
    SpriteVisual,
    TemplateChildRecord,
    TemplateId,
    TemplateRecord,
    TemplateVisual,
} from '@platform/project';

// The registry a linked chunk builds, which is what resolves an attachment's `ScriptId` to a class.
// Both roots take one; `@platform/scripting` is where a host builds it from a chunk's exports.
export type {
    ScriptChunkModule,
    ScriptEntry,
    ScriptRegistry,
    ScriptSide,
} from '@platform/scripting';
