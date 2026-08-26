// The authoring shape: what an editor saves, and the one thing every runtime input is derived from.
// Declarations only — nothing here reads a file, fetches an asset or builds a world.

import type { AssetId, ScriptId, TemplateId } from './ids.js';
import type { ScriptProps } from './props.js';

/**
 * The format this build reads and writes.
 *
 * A file below it is moved forward by `migrate`; a file above it is refused. That is the opposite of
 * `PROTOCOL_VERSION`, which refuses a mismatch in either direction — a peer can be told to update,
 * and a file on disk cannot.
 */
export const PROJECT_FORMAT_VERSION = 1;

/**
 * An axis-aligned rectangle, named by its edges.
 *
 * Restated rather than imported from math: this package's only dependency is a type-only `JsonValue`,
 * so that every consumer can take the authoring types without taking a module graph with them.
 */
export type ProjectBounds = { left: number; right: number; top: number; bottom: number };

/** One named rectangle inside the world's extent — what `find({ in })` and `camera.bounds` resolve. */
export type RegionRecord = { name: string; bounds: ProjectBounds };

/** The authoring vocabulary for assets. The renderer's four kinds are a draw-time narrowing of these. */
export type AssetKind = 'texture' | 'atlas' | 'audio' | 'font' | 'clip' | 'effect';

/** What is known about an asset before it is fetched. An absent member is unknown, not zero. */
export type AssetMeta = { width?: number; height?: number; duration?: number };

/** One panel-loaded asset: an identity, a kind, and the address a client fetches it from. */
export type AssetRecord = {
    id: AssetId;
    kind: AssetKind;
    /** Fetched by the client. Neither the server nor this package ever resolves it. */
    url: string;
    meta?: AssetMeta;
};

/** Where a script runs, from its base class in source. */
export type ScriptLocation = 'server' | 'client' | 'synced';

/** What a script is attached to, from its type parameter in source. */
export type ScriptHost = 'entity' | 'player' | 'game' | 'camera' | 'screen';

/**
 * One script class an authored module exports.
 *
 * `location` and `host` are restated from the source they came from, so the editor can reject an
 * illegal attachment — a synced script on a camera, a server script on a screen — from the manifest
 * alone, without loading the module or running the world.
 */
export type ScriptDecl = {
    id: ScriptId;
    /** The exported binding, so a loader reaches the class without parsing the module. */
    export: string;
    location: ScriptLocation;
    host: ScriptHost;
};

/** One authored source module, and the script classes it exports. */
export type ScriptModule = { path: string; scripts: ScriptDecl[] };

/** One script on one host, with the values it was configured with in the inspector. */
export type ScriptAttachment = { script: ScriptId; props?: ScriptProps };

/** A template whose entities draw a sprite. */
export type SpriteVisual = {
    kind: 'sprite';
    texture: AssetId;
    /** 0..1 pivot inside the art. Absent = centered, the renderer's own default. */
    anchorX?: number;
    anchorY?: number;
    tint?: number;
    /** For visuals that exceed their bounds — glow, thick stroke, emitter. */
    neverCull?: boolean;
};

/** A template whose entities are positional pivots with no art of their own. */
export type GroupVisual = { kind: 'group' };

/**
 * How the entities of one template draw.
 *
 * It carries no transform: those fields are per-entity and authoritative from the simulation, so
 * carrying them here too would give two sources for one value.
 */
export type TemplateVisual = SpriteVisual | GroupVisual;

/**
 * One entity minted beneath a template's root, naming the template it instances.
 *
 * A child names a TEMPLATE rather than restating art, tags and scripts of its own: a subtree is
 * therefore a reference graph, one record per node however many places it appears, and the only
 * thing local to this appearance is where it sits. `validate` closes the graph — every child names
 * a declared template, and no template reaches itself.
 */
export type TemplateChildRecord = {
    template: TemplateId;
    /** Local to the parent node. Hierarchy carries position only, as the runtime's does. */
    transform?: EntityTransform;
};

/** A configured entity, spawnable by key — one row of the editor's tray. */
export type TemplateRecord = {
    id: TemplateId;
    visual: TemplateVisual;
    /** Attached to every instance ever spawned from this template, before any `@onStart` runs. */
    scripts: ScriptAttachment[];
    /**
     * Entities minted beneath every instance, parented to it in this order.
     *
     * ABSENT for a template that is one entity, which is the ordinary case. Present, spawning the
     * template mints the whole subtree — so a turret and its barrel are one spawn key, not two the
     * creator has to parent by hand every time.
     */
    children?: TemplateChildRecord[];
};

/**
 * Where a placed entity sits.
 *
 * Every field defaults — position and rotation to 0, `scale` and `opacity` to 1, `layer` to 0 — so a
 * record carries only what the creator changed. The wire's transform defaults nothing, because it is
 * a whole-value diff target rather than an authored placement.
 */
export type EntityTransform = {
    x?: number;
    y?: number;
    /** Reserved for the 3D backend; `layer` is what orders the 2D draw. */
    z?: number;
    /** Degrees. */
    rotation?: number;
    scale?: number;
    opacity?: number;
    layer?: number;
};

/** Names one row of `ProjectManifest.entities`. Unbranded: it addresses this file and nothing else. */
export type EntityRecordId = string;

/** One entity as the editor placed it — enough to REBUILD it, in ids that survive a reload. */
export type EntityRecord = {
    id: EntityRecordId;
    /** The template it instances, or `null` for an entity configured entirely in place. */
    template: TemplateId | null;
    /** `null` = a child of the world root. A parent's record comes before its children's. */
    parent: EntityRecordId | null;
    transform?: EntityTransform;
    /** Every tag authored on it — what `game.find` queries. */
    tags: string[];
    /** This entity alone; the attachments its template already carries are not repeated here. */
    scripts: ScriptAttachment[];
};

/** The build-time knobs. Fixed when the world is built, so none of these is a runtime value. */
export type ProjectSettings = {
    simRate: number;
    sendRate: number;
    maxPlayers: number;
    /** The world's extent, which `camera.bounds` leashes to and every region sits inside. */
    bounds: ProjectBounds;
    regions: RegionRecord[];
};

/**
 * A whole game, as one file.
 *
 * `entities` holds the placed world directly. There is no `scenes` field and no container between
 * the game and its entities, because Game IS the world — it owns the entities, holds the build-time
 * bounds and scopes spawn and find.
 */
export type ProjectManifest = {
    formatVersion: number;
    /** Stable across saves and across renames — what a build, a share link and a save file agree on. */
    projectId: string;
    /** A digest of the authored content, stamped by whatever wrote the file. */
    contentHash: string;
    settings: ProjectSettings;
    entities: EntityRecord[];
    templates: TemplateRecord[];
    assets: AssetRecord[];
    scriptModules: ScriptModule[];
    /** Attached to the one Game object, which has an inspector of its own rather than a tray row. */
    gameScripts: ScriptAttachment[];
};
