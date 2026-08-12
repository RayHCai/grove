// The `name -> GPU resource` map, atlas expansion, and the retained manifest.
//
// The second job is the easily overlooked one: every successful manifest entry is retained because
// that map is what a context restore merges against, and what lets `unloadAssets` accept entries.
//
// Nothing here rejects on a failed load — unlike `Assets.load` — so one 404 sprite yields a
// placeholder and a reported failure rather than killing a level load.

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
 * The stand-in for an unresolved texture name.
 *
 * Pixi's shared white 1x1, so it needs no upload and its `destroy` is already a no-op — but it also
 * means a missing texture reads as a pale speck rather than as a loud failure.
 */
function makePlaceholder(): Texture {
    return Texture.WHITE;
}

/**
 * name -> texture, plus the retained manifest.
 *
 * Owns no GPU context: it is handed textures by `Assets` and hands them on, so a context loss is
 * the guard's concern rather than this class's.
 */
export class AssetRegistry {
    readonly #resident = new Map<string, ResidentAsset>();

    /** The stand-in every unresolved texture name maps to. */
    readonly placeholder: Texture = makePlaceholder();

    #defaultFilter: TextureFilter = 'nearest';

    /** `'nearest'` by default — kid-drawn pixel art should not blur. */
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

    /** The retained manifest, copied rather than exposed, for `AssetQueue.merge` on restore. */
    retainedManifest(): ReadonlyMap<string, AssetManifestEntry> {
        const out = new Map<string, AssetManifestEntry>();
        for (const [name, resident] of this.#resident) out.set(name, resident.entry);
        return out;
    }

    /** Every resident name. */
    names(): string[] {
        return [...this.#resident.keys()];
    }

    /** Resident names with copied sizes, so an `inspect()` snapshot is not a live view. */
    inspectEntries(): Array<{ name: string; size: Size }> {
        return [...this.#resident].map(([name, asset]) => ({ name, size: { ...asset.size } }));
    }

    /**
     * Uploads one manifest entry, resolving with a `failure` rather than rejecting.
     *
     * A `text` entry is not handled here: it needs a 2D canvas rather than the loader, so pass its
     * finished texture to {@link registerTexture} instead.
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
                    // Rasterized, not fetched: reaching here means a caller bypassed
                    // `createTextAsset`.
                    return {
                        failure: {
                            name: entry.name,
                            reason: "a kind:'text' entry must go through createTextAsset",
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
     * Registers an already-built texture under a name — the text-raster path.
     *
     * The entry is retained too, so a rasterized text asset takes part in retention, unloading,
     * queueing and post-loss re-upload with no special case anywhere.
     */
    registerTexture(entry: AssetManifestEntry, texture: Texture, size: Size): AssetInfo {
        this.#resident.set(entry.name, { texture, size, entry, frames: [] });
        return { name: entry.name, size: { ...size } };
    }

    /**
     * Drops a name and its frames, returning `true` when it was resident.
     *
     * Unconditional: a level transition genuinely wants to force an in-use texture out, and
     * refusing would make the caller destroy nodes in a particular order.
     */
    unload(name: string): boolean {
        const resident = this.#resident.get(name);
        if (resident === undefined) return false;

        for (const frame of resident.frames) this.#resident.delete(frame);
        this.#resident.delete(name);
        // Fire-and-forget: no caller waits on the GPU-side release, and a rejection here would be
        // an unhandled one.
        void Assets.unload(resident.entry.kind === 'image' ? resident.entry.url : name).catch(
            () => undefined,
        );
        return true;
    }

    /** Drops everything. The placeholder survives — it is not a loaded asset. */
    clear(): void {
        this.#resident.clear();
    }

    async #loadImage(entry: Extract<AssetManifestEntry, { kind: 'image' }>): Promise<AssetInfo> {
        const texture = await Assets.load<Texture>(entry.url);
        this.#applyFilter(texture, entry.filter);
        // A declared size wins over the decoded one, so a backend swap cannot change layout.
        const size: Size = entry.size ?? { width: texture.width, height: texture.height };
        this.#resident.set(entry.name, { texture, size, entry, frames: [] });
        return { name: entry.name, size: { ...size } };
    }

    async #loadAtlas(entry: Extract<AssetManifestEntry, { kind: 'atlas' }>): Promise<AssetInfo> {
        const sheet = await Assets.load<Spritesheet>(entry.url);
        const frames: string[] = [];

        // Bare frame names, not `atlas/frame`: the panel authors the manifest and can guarantee
        // cross-sheet uniqueness, so a collision is an authoring bug worth reporting.
        for (const [frameName, frameTexture] of Object.entries(sheet.textures)) {
            if (this.#resident.has(frameName)) {
                this.#collisions.push({ frame: frameName, atlas: entry.name });
                continue;
            }
            this.#applyFilter(frameTexture, entry.filter);
            this.#resident.set(frameName, {
                texture: frameTexture,
                size: { width: frameTexture.width, height: frameTexture.height },
                // The frame's entry points at the atlas, so a restore re-uploads the sheet once.
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
        // A font has no pixel size of its own, but `AssetInfo` still wants one.
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
        // `scaleMode` lives on the texture source, shared by every texture cut from it — which is
        // what an atlas wants.
        texture.source.scaleMode = filter ?? this.#defaultFilter;
    }
}
