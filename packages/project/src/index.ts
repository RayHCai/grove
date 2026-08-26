// @platform/project
// The authoring shape a game is saved as, its validator and format migrations, and the two
// narrowings every runtime input is derived from.

export const PACKAGE_NAME = '@platform/project';

export type { AssetId, ScriptId, TemplateId } from './ids.js';
export { assetId, scriptId, templateId } from './ids.js';

export { PROJECT_FORMAT_VERSION } from './manifest.js';

export type {
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
    ScriptLocation,
    ScriptModule,
    SpriteVisual,
    TemplateRecord,
    TemplateVisual,
} from './manifest.js';

export { ProjectFormatError, validate } from './validate.js';

export type { Migration, MigrationChain } from './migrate.js';
export { MIGRATIONS, migrate } from './migrate.js';

export type {
    GameManifest,
    GameManifestOptions,
    RenderAssetRef,
    RenderManifest,
    RenderTemplateVisual,
    ScriptClass,
    ScriptResolver,
} from './adapters.js';
export { toGameManifest, toRenderManifest } from './adapters.js';
