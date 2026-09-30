export type { AssetId, ScriptId, TemplateId } from './ids.js';
export { assetId, scriptId, templateId } from './ids.js';

export { PROJECT_FORMAT_VERSION } from './manifest.js';

export { MAX_TEMPLATE_DEPTH, RESERVED_KEYS } from './limits.js';

export type { ScriptProps } from './props.js';

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
    TemplateChildRecord,
    TemplateRecord,
    TemplateVisual,
} from './manifest.js';

export { ProjectFormatError, validate } from './validate.js';

export type { Migration, MigrationChain } from './migrate.js';
export { MIGRATIONS, migrate } from './migrate.js';

export type {
    GameManifest,
    GameManifestOptions,
    PlacedEntity,
    RenderAssetRef,
    RenderManifest,
    RenderTemplateVisual,
    ResolvedAttachment,
    ResolvedTemplate,
    ScriptClass,
    ScriptResolver,
    ServerSettings,
} from './adapters.js';
export { toGameManifest, toRenderManifest, toServerSettings } from './adapters.js';
