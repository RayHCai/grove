// The two narrowings out of the authoring shape: what a runtime needs to BUILD a world, and what a
// renderer needs to DRAW one.
//
// Both target shapes are declared here rather than imported from core and protocol, because the
// dependency runs the other way — a consumer takes the authoring types, and neither of those two
// packages may enter this one's graph. Each is written to be assignable to the consumer's own
// declaration, which is what lets the two collapse into these without either shape being authored
// twice.

import type { ScriptId } from './ids.js';
import type {
    AssetKind,
    AssetMeta,
    AssetRecord,
    ProjectBounds,
    ProjectManifest,
    RegionRecord,
    ScriptAttachment,
    TemplateVisual,
} from './manifest.js';

/** A creator script class, as a host holds one. */
export type ScriptClass = new () => object;

/**
 * Resolves an attached script id to the class the host loaded for it.
 *
 * Required rather than optional: a manifest holds ids and a runtime wires classes, and the only
 * layer that can bridge the two is the one that already holds the game's code. Returning `undefined`
 * drops that attachment, which is the resolver's decision to make and not this package's.
 */
export type ScriptResolver = (id: ScriptId) => ScriptClass | undefined;

/** What a runtime is built from: the world's fixed shape, plus the Game-hosted classes to wire. */
export type GameManifest = {
    /** The location filter — which handlers this runtime dispatches, and so its trust boundary. */
    role: 'server' | 'client';
    simRate: number;
    bounds: ProjectBounds;
    regions: RegionRecord[];
    /** No `url`: a runtime loads nothing, so an address it cannot act on is not its to hold. */
    assets: Array<{ key: string; kind: AssetKind; meta?: AssetMeta }>;
    gameScripts: ScriptClass[];
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

function resolveAll(attachments: ScriptAttachment[], resolve: ScriptResolver): ScriptClass[] {
    const classes: ScriptClass[] = [];
    for (const attachment of attachments) {
        const klass = resolve(attachment.script);
        if (klass !== undefined) classes.push(klass);
    }
    return classes;
}
