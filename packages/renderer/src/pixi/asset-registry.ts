// The `name -> GPU resource` map, atlas expansion, and the RETAINED MANIFEST (§1, §9, §10).
//
// Two jobs, and the second is easy to overlook. The obvious one is resolving a name to a texture.
// The load-bearing one is RETAINING every successful manifest entry, because that retained map is
// what a context restore merges against (§10) — without it, a restore has nothing to re-upload
// from, and `unloadAssets` could not accept original entries (§9.2).
//
// NOTHING HERE REJECTS ON A FAILED LOAD. A missing texture yields a magenta placeholder and a
// reported failure, so one 404 sprite cannot kill a level load (§9.1). That is a deliberate
// difference from `Assets.load`, which throws.

import { Assets, Texture } from 'pixi.js';
import type { Spritesheet } from 'pixi.js';
import type { Size } from '@platform/math';
import type { AssetFailure, AssetInfo, AssetManifestEntry, TextureFilter } from '../renderer.js';

/** A resident entry: what we uploaded, how big it is, and the manifest we retained. */
interface ResidentAsset {
    texture: Texture;
    size: Size;
    entry: AssetManifestEntry;
    /** Frame names this entry contributed, for an atlas. Empty otherwise. */
    frames: string[];
}

/** The outcome of one load attempt. `failure` and `info` are mutually exclusive. */
export interface LoadOutcome {
    info?: AssetInfo;
    failure?: AssetFailure;
}

/**
 * A magenta 1x1, tinted at draw time by the sprite that references it.
 *
 * Magenta because it is the traditional "missing texture" colour and appears nowhere in
 * kid-drawn art by accident — a silent fallback to transparent would read as a layout bug.
 */
function makePlaceholder(): Texture {
    return Texture.WHITE;
}

/**
 * name -> texture, plus the retained manifest.
 *
 * Owns no GPU context of its own: it is handed textures by `Assets` and hands them to the node
 * tree, so a context loss is the guard's concern, not this class's.
 */
export class AssetRegistry {
    readonly #resident = new Map<string, ResidentAsset>();

    /** The magenta stand-in every unresolved texture name maps to (§9.1). */
    readonly placeholder: Texture = makePlaceholder();

    #defaultFilter: TextureFilter = 'nearest';

    /** `'nearest'` by default — kid-drawn pixel art should not blur (§11). */
    setDefaultFilter(filter: TextureFilter): void {
        this.#defaultFilter = filter;
    }

    /** The texture for a name, or the placeholder when it is not resident. */
    get(name: string): Texture {
        return this.#resident.get(name)?.texture ?? this.placeholder;
    }

    /** `true` when the name resolves to a real uploaded texture. */
    has(name: string): boolean {
        return this.#resident.has(name);
    }

    /** The declared or measured size, or `null` when the name is unknown. */
    sizeOf(name: string): Readonly<Size> | null {
        return this.#resident.get(name)?.size ?? null;
    }

    /** The kind a resident name was loaded as — `unloadAssets` needs it to defer fonts. */
    kindOf(name: string): AssetManifestEntry['kind'] | null {
        return this.#resident.get(name)?.entry.kind ?? null;
    }

    /**
     * The retained manifest, for `AssetQueue.merge` on restore (§10).
     *
     * A fresh Map rather than a live view: the caller must not be able to mutate our retention
     * by holding this.
     */
    retainedManifest(): ReadonlyMap<string, AssetManifestEntry> {
        const out = new Map<string, AssetManifestEntry>();
        for (const [name, resident] of this.#resident) out.set(name, resident.entry);
        return out;
    }

    /** Every resident name. */
    names(): string[] {
        return [...this.#resident.keys()];
    }

    /**
     * Resident names with their sizes, for `inspect()` (§11.2).
     *
     * Sizes are copied rather than handed out by reference: a snapshot must not be a live view a
     * consumer could mutate our bookkeeping through.
     */
    inspectEntries(): Array<{ name: string; size: Size }> {
        return [...this.#resident].map(([name, asset]) => ({ name, size: { ...asset.size } }));
    }

    /**
     * Uploads one manifest entry.
     *
     * Resolves with a `failure` rather than rejecting, so a caller can report a partial result
     * (§9.1). A `text` entry is NOT handled here — it goes through `text-raster.ts`, which needs
     * a 2D canvas rather than the loader (§9.3); pass its finished texture to
     * {@link registerTexture} instead.
     */
    async load(entry: AssetManifestEntry): Promise<LoadOutcome> {
        try {
            switch (entry.kind) {
                case 'image':
                    return { info: await this.#loadImage(entry) };
                case 'atlas':
                    return { info: await this.#loadAtlas(entry) };
                case 'font':
                    return { info: await this.#loadFont(entry) };
                case 'text':
                    // A text asset's texture is rasterized, not fetched. Reaching here means a
                    // caller bypassed `createTextAsset`.
                    return {
                        failure: {
                            name: entry.name,
                            reason: "a kind:'text' entry must go through createTextAsset (§9.3)",
                        },
                    };
            }
        } catch (error) {
            return {
                failure: {
                    name: entry.name,
                    reason: error instanceof Error ? error.message : String(error),
                },
            };
        }
    }

    /**
     * Registers an already-built texture under a name — the text-raster path (§9.3).
     *
     * Retains the entry too, so a rasterized text asset participates uniformly in retention,
     * unloading, queueing and post-loss re-upload with no special case anywhere.
     */
    registerTexture(entry: AssetManifestEntry, texture: Texture, size: Size): AssetInfo {
        this.#resident.set(entry.name, { texture, size, entry, frames: [] });
        return { name: entry.name, size: { ...size } };
    }

    /**
     * Drops a name and its frames, returning `true` when it was resident.
     *
     * Deliberately unconditional: an in-use texture unloads anyway, because a level transition
     * genuinely wants to force it and refusing would make the caller destroy nodes in a
     * particular order (§9.2). Affected nodes fall back to the placeholder; their ids stay valid.
     */
    unload(name: string): boolean {
        const resident = this.#resident.get(name);
        if (resident === undefined) return false;

        for (const frame of resident.frames) this.#resident.delete(frame);
        this.#resident.delete(name);
        // Fire-and-forget: the GPU-side release is not something a caller waits on, and a
        // rejection here would be an unhandled one.
        void Assets.unload(resident.entry.kind === 'image' ? resident.entry.url : name).catch(
            () => undefined,
        );
        return true;
    }

    /** Drops everything. The placeholder survives — it is not a loaded asset. */
    clear(): void {
        this.#resident.clear();
    }

    // ─── internals ──────────────────────────────────────────────────

    async #loadImage(entry: Extract<AssetManifestEntry, { kind: 'image' }>): Promise<AssetInfo> {
        const texture = await Assets.load<Texture>(entry.url);
        this.#applyFilter(texture, entry.filter);
        // A declared size wins over the decoded one: the panel knows the authored dimensions,
        // and honouring it keeps a backend swap from changing layout.
        const size: Size = entry.size ?? { width: texture.width, height: texture.height };
        this.#resident.set(entry.name, { texture, size, entry, frames: [] });
        return { name: entry.name, size: { ...size } };
    }

    async #loadAtlas(entry: Extract<AssetManifestEntry, { kind: 'atlas' }>): Promise<AssetInfo> {
        const sheet = await Assets.load<Spritesheet>(entry.url);
        const frames: string[] = [];

        // BARE frame names, not `atlas/frame` — the panel authors the manifest and can guarantee
        // cross-sheet uniqueness (§18.5). A collision is a real authoring bug, so it is reported
        // rather than silently resolved.
        for (const [frameName, frameTexture] of Object.entries(sheet.textures)) {
            if (this.#resident.has(frameName)) {
                this.#collisions.push({ frame: frameName, atlas: entry.name });
                continue;
            }
            this.#applyFilter(frameTexture, entry.filter);
            this.#resident.set(frameName, {
                texture: frameTexture,
                size: { width: frameTexture.width, height: frameTexture.height },
                // The frame's own entry points at the atlas, so a restore re-uploads the sheet
                // once rather than each frame separately.
                entry,
                frames: [],
            });
            frames.push(frameName);
        }

        const sheetTexture = sheet.textureSource
            ? new Texture({ source: sheet.textureSource })
            : this.placeholder;
        const size: Size = { width: sheetTexture.width, height: sheetTexture.height };
        this.#resident.set(entry.name, { texture: sheetTexture, size, entry, frames });
        return { name: entry.name, size: { ...size } };
    }

    async #loadFont(entry: Extract<AssetManifestEntry, { kind: 'font' }>): Promise<AssetInfo> {
        await Assets.load(entry.url);
        // A font has no pixel size of its own; the uniform `AssetInfo` shape still wants one.
        const size: Size = { width: 0, height: 0 };
        this.#resident.set(entry.name, { texture: this.placeholder, size, entry, frames: [] });
        return { name: entry.name, size: { ...size } };
    }

    /** Cross-sheet frame-name collisions, for the orchestrator to warn about. */
    readonly #collisions: Array<{ frame: string; atlas: string }> = [];

    /** Drains the recorded frame-name collisions. */
    takeCollisions(): Array<{ frame: string; atlas: string }> {
        return this.#collisions.splice(0, this.#collisions.length);
    }

    #applyFilter(texture: Texture, filter: TextureFilter | undefined): void {
        // `scaleMode` lives on the texture SOURCE in Pixi v8, and it is shared by every texture
        // cut from that source — which is exactly right for an atlas.
        texture.source.scaleMode = filter ?? this.#defaultFilter;
    }
}
