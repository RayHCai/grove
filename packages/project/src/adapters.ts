// The two narrowings out of the authoring shape: what a runtime needs to BUILD a world, and what a
// renderer needs to DRAW one.
//
// Both target shapes are declared here rather than imported from core and protocol, because the
// dependency runs the other way — a consumer takes the authoring types, and neither of those two
// packages may enter this one's graph. Each is written to be assignable to the consumer's own
// declaration, which is what lets the two collapse into these without either shape being authored
// twice.

import type { ScriptId, TemplateId } from './ids.js';
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

/** A creator script class, as a host holds one. Props are optional, so a props-free class fits. */
export type ScriptClass = new (props?: ScriptProps) => object;

/**
 * Resolves an attached script id to the class the host loaded for it.
 *
 * Required rather than optional: a manifest holds ids and a runtime wires classes, and the only
 * layer that can bridge the two is the one that already holds the game's code. Returning `undefined`
 * drops that attachment, which is the resolver's decision to make and not this package's.
 */
export type ScriptResolver = (id: ScriptId) => ScriptClass | undefined;

/**
 * One attachment with its class already resolved.
 *
 * It keeps the `ScriptId` alongside the class rather than replacing it, because a runtime needs both
 * and for different reasons: the class is what it constructs, and the id is what names that class on
 * a wire, where a minified class name is no contract.
 */
export type ResolvedAttachment = { script: ScriptId; klass: ScriptClass; props?: ScriptProps };

/** A template as a runtime holds it: what to attach to every instance, and what to mint beneath it. */
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

/** What a runtime is built from: the world's fixed shape, its templates, and the world as placed. */
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

/** One asset a joining client fetches. Carries the `url` its runtime counterpart drops. */
export type RenderAssetRef = { key: string; kind: AssetKind; url: string; meta?: AssetMeta };

/** A template visual addressed by the key entities spawn under, since a renderer has no records. */
export type RenderTemplateVisual = TemplateVisual & { template: string };

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
