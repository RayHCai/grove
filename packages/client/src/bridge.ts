// The render bridge: the handle map, the per-frame transform push, and the camera.
//
// It holds a `MirrorView` rather than the `Runtime`, so the layer that runs every frame cannot reach
// `rt.transforms.setPosition` by accident.

import type { EntityId } from '@platform/core';
import { NO_ENTITY } from '@platform/core';
import type {
    CameraState,
    IRenderer,
    NodeDesc,
    NodeId,
    NodePatch,
    AssetManifestEntry,
} from '@platform/renderer';
import type { RenderManifest, TemplateVisual, WireAssetRef } from '@platform/protocol';
import type { MirrorDelta, MirrorView } from './mirror.js';

/** Never resident, so the renderer shows its own placeholder; a name it could reject would abort. */
const PLACEHOLDER_TEXTURE = '__missing__';

export class RenderBridge {
    readonly #renderer: IRenderer;
    readonly #view: MirrorView;
    /**
     * Keyed by EntityId, not netId, so the render layer never learns there is a network.
     *
     * One `GameClient` owns its renderer's node namespace exclusively — two on one `IRenderer` would each
     * believe they owned it, and neither would be wrong about its own nodes.
     */
    readonly #nodeFor = new Map<EntityId, NodeId>();
    readonly #templates = new Map<string, TemplateVisual>();

    /**
     * The parenting this bridge applied, both directions, kept here rather than read back per destroy.
     *
     * Walking the renderer's `parentOf` for every entry in the node map costs one call per node per ancestor
     * level per destroyed entity, on a path inside the frame.
     */
    readonly #parentOf = new Map<EntityId, EntityId>();
    readonly #childrenOf = new Map<EntityId, Set<EntityId>>();

    /** Scratch, reused per call: `updateNodes` retains nothing past the call. */
    readonly #patches: NodePatch[] = [];
    readonly #dirty: number[] = [];
    readonly #doomed: EntityId[] = [];

    constructor(renderer: IRenderer, view: MirrorView) {
        this.#renderer = renderer;
        this.#view = view;
    }

    /**
     * Assets to `renderer.loadAssets`, templates into the table a spawn consults.
     *
     * The template loop runs before the first `await`, so a caller may start this and reconcile the join
     * snapshot without waiting; moving it after would draw a whole join as placeholders.
     */
    async loadManifest(manifest: RenderManifest): Promise<void> {
        for (const t of manifest.templates) this.#templates.set(t.template, t);
        const entries = manifest.assets.flatMap(toManifestEntry);
        if (entries.length > 0) await this.#renderer.loadAssets(entries);
    }

    /**
     * Creates, reparents and destroys from the ordered delta rather than by diffing the world.
     *
     * An entity spawned in envelope N and destroyed in N+1 yields `added: [e]` then `removed: [e]`; a
     * set-union would create a node for a dead entity or destroy one never created.
     */
    reconcile(delta: MirrorDelta): void {
        for (const local of delta.added) this.#create(local);
        // Between the two, so a reparent can name an entity created in this same batch.
        for (const { local, parent } of delta.reparented) this.#reparent(local, parent);
        for (const local of delta.removed) this.#destroy(local);
    }

    /**
     * Drains the transform dirty set and patches only what changed.
     *
     * This is the only transform-channel consumer, which is what makes the dirty set a work queue rather
     * than a leak. Patching `liveIds()` instead would resend a few hundred unchanged entities every frame.
     */
    pushTransforms(): void {
        const rt = this.#view.runtime;
        // Indices, not ids. A released slot reads as `NO_ENTITY`: an entity destroyed in the frame it moved
        // leaves its index dirty and its slot empty.
        rt.transforms.consumeDirty(this.#dirty);
        if (this.#dirty.length === 0) return;

        this.#patches.length = 0;
        for (const index of this.#dirty) {
            const local = rt.entities.idAt(index);
            if (local === NO_ENTITY) continue;
            const node = this.#nodeFor.get(local);
            if (node === undefined) continue;
            const scale = rt.transforms.scale(local);
            this.#patches.push({
                id: node,
                position: {
                    x: rt.transforms.posX(local),
                    y: rt.transforms.posY(local),
                    z: rt.transforms.posZ(local),
                },
                rotation: rt.transforms.rotation(local),
                scale: { x: scale, y: scale, z: 1 },
                alpha: rt.transforms.opacity(local),
                layer: rt.transforms.layer(local),
            });
        }
        if (this.#patches.length > 0) this.#renderer.updateNodes(this.#patches);
    }

    /** Unconditionally rather than on change: `applyView` is idempotent, and a missed change is a bug. */
    pushCamera(state: CameraState): void {
        this.#renderer.setCamera(state);
    }

    /** The renderer's world-space viewport, for the camera facade and the cursor quantum. */
    get viewport(): { width: number; height: number } {
        const v = this.#renderer.viewport;
        return { width: Math.abs(v.right - v.left), height: Math.abs(v.top - v.bottom) };
    }

    /** Destroys every node this bridge created, for teardown. */
    clear(): void {
        for (const node of this.#nodeFor.values()) this.#renderer.destroyNode(node);
        this.#nodeFor.clear();
        this.#parentOf.clear();
        this.#childrenOf.clear();
    }

    get nodeCount(): number {
        return this.#nodeFor.size;
    }

    nodeFor(local: EntityId): NodeId | undefined {
        return this.#nodeFor.get(local);
    }

    #create(local: EntityId): void {
        if (this.#nodeFor.has(local)) return;
        const rt = this.#view.runtime;
        const desc = this.#descFor(this.#view.templateOf(local));
        const scale = rt.transforms.scale(local);
        const node = this.#renderer.createNode({
            ...desc,
            position: {
                x: rt.transforms.posX(local),
                y: rt.transforms.posY(local),
                z: rt.transforms.posZ(local),
            },
            rotation: rt.transforms.rotation(local),
            scale: { x: scale, y: scale, z: 1 },
            alpha: rt.transforms.opacity(local),
            layer: rt.transforms.layer(local),
        });
        this.#nodeFor.set(local, node);

        // After creation: the parent's node may be created in this same batch, spawn-order first.
        const parent = rt.entities.record(local)?.parent;
        if (parent !== undefined && parent !== NO_ENTITY) this.#attach(local, parent);
    }

    /** `keepResolvedPosition` stays false: the wire's transform is already local to the parent. */
    #attach(local: EntityId, parent: EntityId): void {
        const node = this.#nodeFor.get(local);
        const parentNode = this.#nodeFor.get(parent);
        if (node === undefined || parentNode === undefined) return;
        this.#renderer.attachNode(node, parentNode);
        this.#parentOf.set(local, parent);
        let children = this.#childrenOf.get(parent);
        if (children === undefined) {
            children = new Set();
            this.#childrenOf.set(parent, children);
        }
        children.add(local);
    }

    #reparent(local: EntityId, parent: EntityId | null): void {
        const node = this.#nodeFor.get(local);
        if (node === undefined) return;
        this.#unlink(local);
        if (parent === null) {
            this.#renderer.detachNode(node);
            return;
        }
        this.#attach(local, parent);
    }

    /** Drops `local` from its parent's child set, leaving its own subtree intact. */
    #unlink(local: EntityId): void {
        const parent = this.#parentOf.get(local);
        if (parent === undefined) return;
        this.#parentOf.delete(local);
        const siblings = this.#childrenOf.get(parent);
        if (siblings === undefined) return;
        siblings.delete(local);
        if (siblings.size === 0) this.#childrenOf.delete(parent);
    }

    #destroy(local: EntityId): void {
        const node = this.#nodeFor.get(local);
        if (node === undefined) return;

        // `destroyNode` cascades the subtree, so one call suffices — but every descendant's map entry must
        // go too, or a later spawn reusing that EntityId finds a stale node. A grandchild's parent is the
        // child, so this walks ancestry rather than the immediate parent.
        this.#doomed.length = 0;
        this.#doomed.push(local);
        for (let i = 0; i < this.#doomed.length; i++) {
            const children = this.#childrenOf.get(this.#doomed[i] as EntityId);
            if (children !== undefined) for (const child of children) this.#doomed.push(child);
        }

        this.#unlink(local);
        for (const id of this.#doomed) {
            this.#nodeFor.delete(id);
            this.#parentOf.delete(id);
            this.#childrenOf.delete(id);
        }
        this.#doomed.length = 0;

        this.#renderer.destroyNode(node);
    }

    /**
     * A missing template draws a placeholder rather than being skipped: an entity in the simulation but not
     * on screen is the harder bug to see.
     *
     * The empty case is not hypothetical — spawn in envelope N and destroy in N+1 reconciles after both
     * applies, so `templateOf` reads `''`, and the renderer rejects an empty texture name outright.
     */
    #descFor(template: string): NodeDesc {
        const visual = this.#templates.get(template);
        if (visual === undefined) {
            return { kind: 'sprite', texture: template === '' ? PLACEHOLDER_TEXTURE : template };
        }
        if (visual.kind === 'group') return { kind: 'group' };
        const desc: NodeDesc = { kind: 'sprite', texture: visual.texture };
        if (visual.anchorX !== undefined || visual.anchorY !== undefined) {
            desc.anchor = { x: visual.anchorX ?? 0.5, y: visual.anchorY ?? 0.5, z: 0 };
        }
        if (visual.tint !== undefined) desc.tint = visual.tint;
        if (visual.neverCull !== undefined) desc.neverCull = visual.neverCull;
        return desc;
    }
}

/**
 * Schemes a manifest URL may use. The server chooses this string and the client fetches it, so it is
 * the one wire field that makes the client act on the network rather than parse — and `javascript:`
 * or a megabyte `data:` URL would be executed or decoded by the loader, not by anything here.
 *
 * Relative URLs carry no scheme and are the common case, so they pass; anything with a scheme must
 * name one of these.
 */
const ALLOWED_ASSET_SCHEMES = new Set(['http:', 'https:']);

/**
 * True when a manifest URL is safe to hand the asset loader.
 *
 * Parsed rather than pattern-matched, because the interesting evasions are lexical — leading
 * whitespace, embedded newlines, mixed case — and `URL` normalizes all of them before the check.
 */
function isFetchableUrl(url: string): boolean {
    if (typeof url !== 'string' || url === '') return false;
    try {
        // A relative URL only resolves against a base, and its scheme is then the document's own.
        // `new URL` rather than `URL.parse`, which is too new to assume in a browser this ships to.
        return ALLOWED_ASSET_SCHEMES.has(new URL(url, 'https://asset.invalid/').protocol);
    } catch {
        return false;
    }
}

/** Core's kinds are not the renderer's, and `audio`/`clip`/`effect` are not renderer assets at all. */
function toManifestEntry(ref: WireAssetRef): AssetManifestEntry[] {
    if (!isFetchableUrl(ref.url)) return [];
    switch (ref.kind) {
        case 'texture': {
            const entry: AssetManifestEntry = { name: ref.key, kind: 'image', url: ref.url };
            const { width, height } = ref.meta ?? {};
            if (width !== undefined && height !== undefined) entry.size = { width, height };
            return [entry];
        }
        case 'atlas':
            return [{ name: ref.key, kind: 'atlas', url: ref.url }];
        case 'font':
            return [{ name: ref.key, kind: 'font', url: ref.url }];
        case 'audio':
        case 'clip':
        case 'effect':
            return [];
    }
}
