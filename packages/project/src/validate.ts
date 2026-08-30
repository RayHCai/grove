// It refuses rather than repairs, and it returns the value it was handed rather than a copy — a
// project file is the creator's own text, and a loader that silently rewrote it would make "what
// does this project contain" unanswerable from the file.

import type {
    AssetKind,
    AssetMeta,
    EntityTransform,
    ProjectBounds,
    ProjectManifest,
    ScriptHost,
    ScriptLocation,
    SpriteVisual,
} from './manifest.js';
import { PROJECT_FORMAT_VERSION } from './manifest.js';

/** Why a value is not a `ProjectManifest`, and where in it the fault sits. */
export class ProjectFormatError extends Error {
    /** Dotted path to the offending member; `''` names the manifest itself. */
    readonly path: string;

    constructor(path: string, message: string) {
        super(path === '' ? message : `${path}: ${message}`);
        this.name = 'ProjectFormatError';
        this.path = path;
    }
}

/**
 * Object keys a `props` map may not carry, because they poison a downstream recursive merge.
 *
 * The same three transport's codec refuses, restated rather than imported: reaching for its set
 * would be a VALUE import, and this package's single dependency is type-only so that every consumer
 * can take the authoring types without taking transport's module graph with them.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Nesting a `props` value may reach. The walk below recurses, so this bound is a stack bound. */
const MAX_PROP_DEPTH = 32;

/**
 * Levels a template subtree may nest.
 *
 * A child names a template, so the graph is a reference graph and one instantiation can be far
 * deeper than any single record looks — which is why the bound is here, on the graph, rather than on
 * a per-record child count that bounds nothing on its own.
 */
const MAX_TEMPLATE_DEPTH = 8;

/** Each table is keyed by the type it mirrors, so manifest.ts cannot grow a member unnoticed. */
function isMember<K extends string>(table: Record<K, true>, value: string): value is K {
    return Object.hasOwn(table, value);
}

const ASSET_KINDS: Record<AssetKind, true> = {
    texture: true,
    atlas: true,
    audio: true,
    font: true,
    clip: true,
    effect: true,
};
const SCRIPT_LOCATIONS: Record<ScriptLocation, true> = { server: true, client: true, synced: true };
const SCRIPT_HOSTS: Record<ScriptHost, true> = {
    entity: true,
    player: true,
    game: true,
    camera: true,
    screen: true,
};

const BOUNDS_EDGES: Record<keyof ProjectBounds, true> = {
    left: true,
    right: true,
    top: true,
    bottom: true,
};
const ASSET_META_FIELDS: Record<keyof AssetMeta, true> = {
    width: true,
    height: true,
    duration: true,
};
type SpriteNumber = Exclude<keyof SpriteVisual, 'kind' | 'texture' | 'neverCull'>;
const SPRITE_NUMBERS: Record<SpriteNumber, true> = { anchorX: true, anchorY: true, tint: true };
const TRANSFORM_FIELDS: Record<keyof EntityTransform, true> = {
    x: true,
    y: true,
    z: true,
    rotation: true,
    scale: true,
    opacity: true,
    layer: true,
};

/**
 * Narrows an untrusted parse to a `ProjectManifest`, or throws a {@link ProjectFormatError} naming
 * the member that failed.
 *
 * `formatVersion` must already be current, so an older file goes through `migrate` first — the two
 * are separate calls because migration rewrites and validation does not.
 */
export function validate(value: unknown): ProjectManifest {
    const manifest = readObject(value, '');

    const formatVersion = readNumber(manifest['formatVersion'], 'formatVersion');
    if (formatVersion !== PROJECT_FORMAT_VERSION) {
        fail(
            'formatVersion',
            `expected ${PROJECT_FORMAT_VERSION}, received ${formatVersion} — migrate the file first`,
        );
    }
    readKey(manifest['projectId'], 'projectId');
    readKey(manifest['contentHash'], 'contentHash');

    readSettings(manifest['settings'], 'settings');

    // Declaration order, because each table below is checked against the ones already built:
    // a template's texture must name an asset, an attachment must name a declared script.
    const assets = readAssets(manifest['assets'], 'assets');
    const hosts = readScriptModules(manifest['scriptModules'], 'scriptModules');
    const templates = readTemplates(manifest['templates'], 'templates', assets, hosts);
    readEntities(manifest['entities'], 'entities', templates, hosts);
    readAttachments(manifest['gameScripts'], 'gameScripts', hosts, 'game');

    return value as ProjectManifest;
}

function readSettings(value: unknown, path: string): void {
    const settings = readObject(value, path);
    readRate(settings['simRate'], `${path}.simRate`);
    readRate(settings['sendRate'], `${path}.sendRate`);
    readRate(settings['maxPlayers'], `${path}.maxPlayers`);
    readBounds(settings['bounds'], `${path}.bounds`);

    const seen = new Set<string>();
    for (const [index, entry] of readArray(settings['regions'], `${path}.regions`).entries()) {
        const at = `${path}.regions[${index}]`;
        const region = readObject(entry, at);
        const name = readKey(region['name'], `${at}.name`);
        if (seen.has(name)) fail(`${at}.name`, `duplicate region name "${name}"`);
        seen.add(name);
        readBounds(region['bounds'], `${at}.bounds`);
    }
}

/** Four finite edges and no ordering rule: the names are read in the space that produced them. */
function readBounds(value: unknown, path: string): void {
    const bounds = readObject(value, path);
    for (const edge of Object.keys(BOUNDS_EDGES)) {
        readNumber(bounds[edge], `${path}.${edge}`);
    }
}

function readAssets(value: unknown, path: string): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const [index, entry] of readArray(value, path).entries()) {
        const at = `${path}[${index}]`;
        const asset = readObject(entry, at);
        const id = readKey(asset['id'], `${at}.id`);
        if (ids.has(id)) fail(`${at}.id`, `duplicate asset id "${id}"`);
        ids.add(id);

        const kind = readString(asset['kind'], `${at}.kind`);
        if (!isMember(ASSET_KINDS, kind)) fail(`${at}.kind`, `unknown asset kind "${kind}"`);
        readKey(asset['url'], `${at}.url`);
        readAssetMeta(asset['meta'], `${at}.meta`);
    }
    return ids;
}

function readAssetMeta(value: unknown, path: string): void {
    if (value === undefined) return;
    const meta = readObject(value, path);
    for (const field of Object.keys(ASSET_META_FIELDS)) {
        if (meta[field] !== undefined) readNumber(meta[field], `${path}.${field}`);
    }
}

/** Returns the host each declared script takes, which is all an attachment site has to check. */
function readScriptModules(value: unknown, path: string): ReadonlyMap<string, ScriptHost> {
    const hosts = new Map<string, ScriptHost>();
    for (const [index, entry] of readArray(value, path).entries()) {
        const at = `${path}[${index}]`;
        const module = readObject(entry, at);
        readKey(module['path'], `${at}.path`);

        for (const [i, declEntry] of readArray(module['scripts'], `${at}.scripts`).entries()) {
            const declAt = `${at}.scripts[${i}]`;
            const decl = readObject(declEntry, declAt);
            const id = readKey(decl['id'], `${declAt}.id`);
            if (hosts.has(id)) fail(`${declAt}.id`, `duplicate script id "${id}"`);

            readKey(decl['export'], `${declAt}.export`);
            const location = readString(decl['location'], `${declAt}.location`);
            if (!isMember(SCRIPT_LOCATIONS, location)) {
                fail(`${declAt}.location`, `unknown script location "${location}"`);
            }
            const host = readString(decl['host'], `${declAt}.host`);
            if (!isMember(SCRIPT_HOSTS, host)) {
                fail(`${declAt}.host`, `unknown script host "${host}"`);
            }
            hosts.set(id, host);
        }
    }
    return hosts;
}

function readTemplates(
    value: unknown,
    path: string,
    assets: ReadonlySet<string>,
    hosts: ReadonlyMap<string, ScriptHost>,
): ReadonlySet<string> {
    const entries = readArray(value, path);

    // Ids first, because a child may name a template declared further down the array — unlike an
    // entity's parent, which is ordered so a loader builds the hierarchy in one pass. A template
    // graph has no such order to impose: two templates may legally reference each other's siblings.
    const ids = new Set<string>();
    const rows: Array<{ at: string; id: string; record: Record<string, unknown> }> = [];
    for (const [index, entry] of entries.entries()) {
        const at = `${path}[${index}]`;
        const record = readObject(entry, at);
        const id = readKey(record['id'], `${at}.id`);
        if (ids.has(id)) fail(`${at}.id`, `duplicate template id "${id}"`);
        ids.add(id);
        rows.push({ at, id, record });
    }

    const children = new Map<string, string[]>();
    for (const row of rows) {
        readVisual(row.record['visual'], `${row.at}.visual`, assets);
        // Entity-hosted: a template configures entities, and the tray drop reaches every instance
        // spawned from it and nothing else.
        readAttachments(row.record['scripts'], `${row.at}.scripts`, hosts, 'entity');
        children.set(
            row.id,
            readTemplateChildren(row.record['children'], `${row.at}.children`, ids),
        );
    }

    closeTemplates(children, path);
    return ids;
}

/** The templates one record hangs beneath itself, in order. Each names a declared template. */
function readTemplateChildren(value: unknown, path: string, ids: ReadonlySet<string>): string[] {
    if (value === undefined) return [];
    const out: string[] = [];
    for (const [index, entry] of readArray(value, path).entries()) {
        const at = `${path}[${index}]`;
        const child = readObject(entry, at);
        const key = readKey(child['template'], `${at}.template`);
        if (!ids.has(key)) fail(`${at}.template`, `no template named "${key}"`);
        readTransform(child['transform'], `${at}.transform`);
        out.push(key);
    }
    return out;
}

/**
 * Refuses a template that reaches itself or a subtree that nests past the bound.
 *
 * Both are the same fault seen from either end: instantiating either one mints entities until
 * something else stops it, and the thing that would stop it is memory.
 *
 * Each template's height is measured once and kept, so a node reachable by many paths costs one
 * visit rather than one per path — a diamond stays legal, and a wide legal graph stays linear. The
 * open set is the path currently being measured, which is what a cycle is detected against and what
 * keeps this recursion no deeper than the cap.
 */
function closeTemplates(children: ReadonlyMap<string, string[]>, path: string): void {
    const open = new Set<string>();
    const heights = new Map<string, number>();

    const measure = (id: string, root: string): number => {
        if (open.has(id)) fail(path, `template "${id}" contains itself`);
        const known = heights.get(id);
        if (open.size + (known ?? 1) > MAX_TEMPLATE_DEPTH) {
            fail(path, `template "${root}" nests deeper than ${MAX_TEMPLATE_DEPTH}`);
        }
        if (known !== undefined) return known;

        open.add(id);
        let tallest = 0;
        for (const child of children.get(id) ?? []) {
            const height = measure(child, root);
            if (height > tallest) tallest = height;
        }
        open.delete(id);

        heights.set(id, tallest + 1);
        return tallest + 1;
    };

    for (const id of children.keys()) measure(id, id);
}

function readVisual(value: unknown, path: string, assets: ReadonlySet<string>): void {
    const visual = readObject(value, path);
    const kind = readString(visual['kind'], `${path}.kind`);
    if (kind === 'group') return;
    if (kind !== 'sprite') fail(`${path}.kind`, `unknown template visual "${kind}"`);

    const texture = readKey(visual['texture'], `${path}.texture`);
    if (!assets.has(texture)) fail(`${path}.texture`, `no asset named "${texture}"`);
    for (const field of Object.keys(SPRITE_NUMBERS)) {
        if (visual[field] !== undefined) readNumber(visual[field], `${path}.${field}`);
    }
    if (visual['neverCull'] !== undefined) readBoolean(visual['neverCull'], `${path}.neverCull`);
}

function readEntities(
    value: unknown,
    path: string,
    templates: ReadonlySet<string>,
    hosts: ReadonlyMap<string, ScriptHost>,
): void {
    const seen = new Set<string>();
    for (const [index, entry] of readArray(value, path).entries()) {
        const at = `${path}[${index}]`;
        const entity = readObject(entry, at);
        const id = readKey(entity['id'], `${at}.id`);
        if (seen.has(id)) fail(`${at}.id`, `duplicate entity id "${id}"`);

        if (entity['template'] !== null) {
            const key = readKey(entity['template'], `${at}.template`);
            if (!templates.has(key)) fail(`${at}.template`, `no template named "${key}"`);
        }

        if (entity['parent'] !== null) {
            const key = readKey(entity['parent'], `${at}.parent`);
            // Checked against what has been read SO FAR, which is what makes the rule
            // parents-before-children — so a loader builds the hierarchy in one pass.
            if (!seen.has(key)) fail(`${at}.parent`, `no entity "${key}" before this one`);
        }
        seen.add(id);

        readTransform(entity['transform'], `${at}.transform`);
        readTags(entity['tags'], `${at}.tags`);
        readAttachments(entity['scripts'], `${at}.scripts`, hosts, 'entity');
    }
}

function readTransform(value: unknown, path: string): void {
    if (value === undefined) return;
    const transform = readObject(value, path);
    for (const field of Object.keys(TRANSFORM_FIELDS)) {
        if (transform[field] !== undefined) readNumber(transform[field], `${path}.${field}`);
    }
}

function readTags(value: unknown, path: string): void {
    const seen = new Set<string>();
    for (const [index, tag] of readArray(value, path).entries()) {
        const name = readKey(tag, `${path}[${index}]`);
        if (seen.has(name)) fail(`${path}[${index}]`, `duplicate tag "${name}"`);
        seen.add(name);
    }
}

function readAttachments(
    value: unknown,
    path: string,
    hosts: ReadonlyMap<string, ScriptHost>,
    host: ScriptHost,
): void {
    const seen = new Set<string>();
    for (const [index, entry] of readArray(value, path).entries()) {
        const at = `${path}[${index}]`;
        const attachment = readObject(entry, at);
        const id = readKey(attachment['script'], `${at}.script`);

        const declared = hosts.get(id);
        if (declared === undefined) fail(`${at}.script`, `no script declared as "${id}"`);
        if (declared !== host) {
            fail(`${at}.script`, `"${id}" is ${declared}-hosted and cannot attach to a ${host}`);
        }
        // A second instance of one class on one host would declare its `@serverState` names twice,
        // which is a load error there rather than something to discover at attach time.
        if (seen.has(id)) fail(`${at}.script`, `"${id}" is attached twice`);
        seen.add(id);

        if (attachment['props'] !== undefined) readProps(attachment['props'], `${at}.props`);
    }
}

function readProps(value: unknown, path: string): void {
    checkJsonValue(readObject(value, path), path, 0);
}

/**
 * Refuses a reserved key rather than stripping it — deleting one would alter the file, which is the
 * silent-transform failure in miniature.
 */
function checkJsonValue(value: unknown, path: string, depth: number): void {
    if (depth > MAX_PROP_DEPTH) fail(path, `nested deeper than ${MAX_PROP_DEPTH}`);
    switch (typeof value) {
        case 'boolean':
        case 'string':
            return;
        case 'number':
            if (!Number.isFinite(value)) fail(path, 'a non-finite number has no JSON spelling');
            return;
        case 'object': {
            if (value === null) return;
            if (Array.isArray(value)) {
                for (const [index, item] of (value as unknown[]).entries()) {
                    checkJsonValue(item, `${path}[${index}]`, depth + 1);
                }
                return;
            }
            for (const [key, member] of Object.entries(value)) {
                if (RESERVED_KEYS.has(key)) fail(`${path}.${key}`, 'reserved key');
                checkJsonValue(member, `${path}.${key}`, depth + 1);
            }
            return;
        }
        default:
            fail(path, `${describe(value)} has no JSON spelling`);
    }
}

function fail(path: string, message: string): never {
    throw new ProjectFormatError(path, message);
}

function readObject(value: unknown, path: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail(path, `expected an object, received ${describe(value)}`);
    }
    return value as Record<string, unknown>;
}

function readArray(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value)) fail(path, `expected an array, received ${describe(value)}`);
    return value as unknown[];
}

function readString(value: unknown, path: string): string {
    if (typeof value !== 'string') fail(path, `expected a string, received ${describe(value)}`);
    return value;
}

/** A string that names something. Empty is refused: it reads as absent wherever it is compared. */
function readKey(value: unknown, path: string): string {
    const key = readString(value, path);
    if (key === '') fail(path, 'may not be empty');
    return key;
}

function readNumber(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(path, `expected a finite number, received ${describe(value)}`);
    }
    return value;
}

/** A per-second rate or a head count. Zero makes `dt` infinite, so the world would never step. */
function readRate(value: unknown, path: string): number {
    const rate = readNumber(value, path);
    if (!Number.isInteger(rate) || rate < 1) {
        fail(path, `expected a positive integer, received ${rate}`);
    }
    return rate;
}

function readBoolean(value: unknown, path: string): boolean {
    if (typeof value !== 'boolean') fail(path, `expected a boolean, received ${describe(value)}`);
    return value;
}

function describe(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'an array';
    return typeof value;
}
