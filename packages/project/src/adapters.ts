// Both target shapes are declared here rather than imported from core and protocol: the dependency
// runs the other way, and neither package may enter this one's graph.

import type { AssetId, ScriptId, TemplateId } from './ids.js';
import type {
    AssetKind,
    AssetMeta,
    AssetRecord,
    EntityRecord,
    EntityRecordId,
    EntityTransform,
    ProjectBounds,
    ProjectManifest,
    RegionRecord,
    ScriptAttachment,
    TemplateChildRecord,
    TemplateRecord,
    TemplateVisual,
} from './manifest.js';
import type { ScriptProps } from './props.js';

/**
 * A creator script class, as a host holds one. Props are optional, so a props-free class fits.
 * Opaque in its return because this package may not name core's `BaseScript`; core widens it at
 * the one attach site, which is where an authored class is taken on trust.
 */
export type ScriptClass = new (props?: ScriptProps) => object;

/** Resolves an attached script id to the class the host loaded. `undefined` drops it. */
export type ScriptResolver = (id: ScriptId) => ScriptClass | undefined;

/** One attachment with its class resolved; the `ScriptId` stays, since the wire names that. */
export type ResolvedAttachment = { script: ScriptId; klass: ScriptClass; props?: ScriptProps };

/** A template as a runtime holds it: what to attach to each instance, and what to mint below. */
export type ResolvedTemplate = {
    id: TemplateId;
    scripts: ResolvedAttachment[];
    children: TemplateChildRecord[];
};

/** One placed entity as a runtime builds it. A parent's record comes before its children's. */
export type PlacedEntity = {
    id: EntityRecordId;
    template: TemplateId | null;
    parent: EntityRecordId | null;
    transform?: EntityTransform;
    tags: string[];
    scripts: ResolvedAttachment[];
};

/** What a runtime is built from: the world's fixed shape, its templates, and the placed world. */
export type GameManifest = {
    /** The location filter — which handlers this runtime dispatches, and so its trust boundary. */
    role: 'server' | 'client';
    simRate: number;
    bounds: ProjectBounds;
    regions: RegionRecord[];
    /** No `url`: a runtime loads nothing, so an address it cannot act on is not its to hold. */
    assets: Array<{ key: string; kind: AssetKind; meta?: AssetMeta }>;
    templates: ResolvedTemplate[];
    /** The placed world, parents before children — `validate` is what makes that hold. */
    entities: PlacedEntity[];
    gameScripts: ResolvedAttachment[];
};

export type GameManifestOptions = { role: 'server' | 'client'; scripts: ScriptResolver };

/** Narrows a project to what builds a world. */
export function toGameManifest(project: ProjectManifest, opts: GameManifestOptions): GameManifest {
    const settings = project.settings;
    return {
        role: opts.role,
        simRate: settings.simRate,
        bounds: settings.bounds,
        regions: settings.regions.map((region) => ({ name: region.name, bounds: region.bounds })),
        assets: project.assets.map(toRuntimeAsset),
        templates: project.templates.map((template) => toResolvedTemplate(template, opts.scripts)),
        entities: project.entities.map((entity) => toPlacedEntity(entity, opts.scripts)),
        gameScripts: resolveAll(project.gameScripts, opts.scripts),
    };
}

/** The two wire rates, which no runtime reads: core simulates and neither sends. */
export type ServerSettings = { sendRate: number; maxPlayers: number };

/** Narrows a project to what a host serves it with. */
export function toServerSettings(project: ProjectManifest): ServerSettings {
    return { sendRate: project.settings.sendRate, maxPlayers: project.settings.maxPlayers };
}

/** One asset a joining client fetches. Carries the `url` its runtime counterpart drops. */
export type RenderAssetRef = { key: AssetId; kind: AssetKind; url: string; meta?: AssetMeta };

/** A template visual addressed by the key entities spawn under, since a renderer has no records. */
export type RenderTemplateVisual = TemplateVisual & { template: TemplateId };

/** What a renderer needs to draw a template at all: the art, and which art each template draws. */
export type RenderManifest = { assets: RenderAssetRef[]; templates: RenderTemplateVisual[] };

/** Narrows a project to what draws one. */
export function toRenderManifest(project: ProjectManifest): RenderManifest {
    return {
        assets: project.assets.map(toRenderAsset),
        templates: project.templates.map((template) => ({
            ...template.visual,
            template: template.id,
        })),
    };
}

function toRuntimeAsset(asset: AssetRecord): { key: string; kind: AssetKind; meta?: AssetMeta } {
    return { key: asset.id, kind: asset.kind, ...metaOf(asset) };
}

function toRenderAsset(asset: AssetRecord): RenderAssetRef {
    return { key: asset.id, kind: asset.kind, url: asset.url, ...metaOf(asset) };
}

/** An absent `meta` stays an absent KEY: `exactOptionalPropertyTypes` refuses an explicit one. */
function metaOf(asset: AssetRecord): { meta?: AssetMeta } {
    return asset.meta === undefined ? {} : { meta: asset.meta };
}

function toResolvedTemplate(template: TemplateRecord, resolve: ScriptResolver): ResolvedTemplate {
    return {
        id: template.id,
        scripts: resolveAll(template.scripts, resolve),
        children: template.children ?? [],
    };
}

function toPlacedEntity(entity: EntityRecord, resolve: ScriptResolver): PlacedEntity {
    return {
        id: entity.id,
        template: entity.template,
        parent: entity.parent,
        ...(entity.transform === undefined ? {} : { transform: entity.transform }),
        tags: entity.tags,
        scripts: resolveAll(entity.scripts, resolve),
    };
}

function resolveAll(
    attachments: ScriptAttachment[],
    resolve: ScriptResolver,
): ResolvedAttachment[] {
    const out: ResolvedAttachment[] = [];
    for (const attachment of attachments) {
        const klass = resolve(attachment.script);
        if (klass === undefined) continue;
        out.push({
            script: attachment.script,
            klass,
            ...(attachment.props === undefined ? {} : { props: attachment.props }),
        });
    }
    return out;
}
