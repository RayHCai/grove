// Holds a `MirrorView`, not the `Runtime`, so the per-frame layer cannot reach `setPosition`.

import type { EntityId } from '@platform/core';
import { NO_ENTITY } from '@platform/core';
import type {
    CameraState,
    IRenderer,
    NodeDesc,
    NodeId,
    NodePatch,
    SubtreeNodeDesc,
    AssetManifestEntry,
} from '@platform/renderer';
import { AssetQueue, NO_NODE, REMOTE_ASSET_SCHEMES, isAllowedAssetUrl } from '@platform/renderer';
import type {
    GroupTemplateVisual,
    RenderManifest,
    TemplateChild,
    TemplateVisual,
    WireAssetRef,
} from '@platform/protocol';
import { isFiniteNumber } from '@platform/math';
import {
    CORRECTION_SMOOTH_SECONDS,
    MAX_FRAME_DT,
    MAX_INTERPOLATION_DELAY_SECONDS,
    MAX_TEMPLATE_DEPTH,
    MAX_TEMPLATE_NODES,
    MAX_WIRE_ITEMS,
} from './constants.js';
import type { MirrorDelta, MirrorView } from './mirror.js';

/** Never resident, so the renderer shows its placeholder; a name it could reject would abort. */
const PLACEHOLDER_TEXTURE = '__missing__';

/** What a `NodeDesc` and a `NodePatch` spell identically, so one read can serve either. */
type TransformFields = Pick<NodePatch, 'position' | 'rotation' | 'scale' | 'alpha' | 'layer'>;

/** Nothing predicted until a `Prediction` says otherwise; a client without one interpolates all. */
const NOTHING_PREDICTED: ReadonlySet<EntityId> = new Set();

/** One authoritative pose, stamped with the frame's own seconds — the base this file works in. */
interface Sample {
    time: number;
    x: number;
    y: number;
    z: number;
    rotation: number;
    scale: number;
    alpha: number;
    layer: number;
}

/** The two samples an entity is drawn between, and whether the pose reached the later one. */
interface Track {
    from: Sample;
    to: Sample;
    /** The drawn pose is `to` and needs no more patches until a sample lands. */
    settled: boolean;
}

/** What is added to a drawn position now, and the seconds until it is nothing; decayed in place. */
export interface Correction {
    x: number;
    y: number;
    z: number;
    remaining: number;
}

const NO_CORRECTION: Correction = { x: 0, y: 0, z: 0, remaining: 0 };

export class RenderBridge {
    readonly #renderer: IRenderer;
    readonly #view: MirrorView;
    /** Keyed by EntityId, not netId, so the render layer never learns there is a network. */
    readonly #nodeFor = new Map<EntityId, NodeId>();
    /** The reverse edge, so a picked node can name the entity a pointer hit. */
    readonly #entityFor = new Map<NodeId, EntityId>();
    readonly #templates = new Map<string, TemplateVisual>();
    /** Every asset name declared to the renderer; re-declaring an entry then costs nothing. */
    readonly #assets = new AssetQueue();

    /** Group templates that draw a subtree, flattened into a `createSubtree` batch. Root first. */
    readonly #subtreeFor = new Map<string, SubtreeNodeDesc[]>();

    /** Scratch, reused per spawn: `createSubtree` retains neither array past the call. */
    readonly #batch: SubtreeNodeDesc[] = [];
    readonly #created: NodeId[] = [];

    /** The parenting this bridge applied, both directions; a read-back per destroy costs a walk. */
    readonly #parentOf = new Map<EntityId, EntityId>();
    readonly #childrenOf = new Map<EntityId, Set<EntityId>>();

    /** Display-only offsets, decaying to nothing; never written back into the simulation. */
    readonly #corrections = new Map<EntityId, Correction>();

    /** Samples an unpredicted entity is drawn between; else send rate is visible motion rate. */
    readonly #tracks = new Map<EntityId, Track>();

    /** What prediction owns, held live; the set is refilled in place, so membership refreshes. */
    #predicted: ReadonlySet<EntityId> = NOTHING_PREDICTED;

    /** Seconds behind the newest sample a buffered entity is drawn: one send interval, capped. */
    readonly #delay: number;

    /** The moment being drawn — the last push's, so `#create` and the camera read the same one. */
    #renderTime = 0;

    /** Scratch, reused per call: `updateNodes` retains nothing past the call. */
    readonly #patches: NodePatch[] = [];
    readonly #dirty: number[] = [];
    readonly #doomed: EntityId[] = [];
    readonly #moved = new Set<EntityId>();
    readonly #expired: EntityId[] = [];

    /** The frame source's seconds at the last push, and the only time base this file holds. */
    #lastNow: number | undefined;

    /** `sendRate` is `Welcome`'s: the interval between transforms, so the delay to draw behind. */
    constructor(renderer: IRenderer, view: MirrorView, sendRate: number) {
        this.#renderer = renderer;
        this.#view = view;
        // `isUsableWelcome` bars a bad rate; the cap keeps a hand-built one working.
        this.#delay =
            sendRate > 0
                ? Math.min(1 / sendRate, MAX_INTERPOLATION_DELAY_SECONDS)
                : MAX_INTERPOLATION_DELAY_SECONDS;
    }

    /** Names entities the buffer must leave alone; one handed to both smoothers rubber-bands. */
    setPredicted(scope: ReadonlySet<EntityId>): void {
        this.#predicted = scope;
    }

    /**
     * Merges a manifest in, additively; the welcome's copy is a baseline, not the whole session.
     * Templates land before the first `await`, or a join draws as placeholders.
     */
    async loadManifest(manifest: RenderManifest): Promise<void> {
        for (const t of manifest.templates) {
            if (t.kind === 'group' && t.children !== undefined) {
                const batch = flattenGroup(t);
                // A refused child list drops the whole template rather than half of it: an unknown
                // template draws the placeholder, where a truncated subtree draws as if it were
                // complete and the missing art is invisible.
                if (batch === undefined) continue;
                this.#subtreeFor.set(t.template, batch);
            }
            this.#templates.set(t.template, t);
        }

        // Deduped through the renderer's own per-name intent map rather than a second table here:
        // one answer to "is this name already declared", and a re-declared asset is not re-fetched.
        const entries: AssetManifestEntry[] = [];
        for (const entry of manifest.assets.flatMap(toManifestEntry)) {
            if (this.#assets.intentFor(entry.name) !== undefined) continue;
            this.#assets.load(entry);
            entries.push(entry);
        }
        if (entries.length > 0) await this.#renderer.loadAssets(entries);
    }

    /** Creates, reparents and destroys from the ordered delta, never by diffing the world. */
    reconcile(delta: MirrorDelta): void {
        for (const local of delta.added) this.#create(local);
        // Between the two, so a reparent can name an entity created in this same batch.
        for (const { local, parent } of delta.reparented) this.#reparent(local, parent);
        for (const local of delta.removed) this.#destroy(local);
    }

    /**
     * Patches what changed, what is still easing, and what is still interpolating.
     * The only transform-channel consumer, so the dirty set is a work queue, not a leak.
     */
    pushTransforms(nowSeconds: number): void {
        const rt = this.#view.runtime;
        this.#decay(nowSeconds);
        // `#decay` discarded a non-finite time: every alpha from a `NaN` time is `NaN`.
        const now = this.#lastNow ?? 0;
        this.#renderTime = now - this.#delay;

        // Indices, not ids: a released slot reads `NO_ENTITY`.
        rt.transforms.consumeDirty(this.#dirty);

        this.#moved.clear();
        for (const index of this.#dirty) {
            const local = rt.entities.idAt(index);
            if (local === NO_ENTITY) continue;
            this.#moved.add(local);
            // Only wire poses are samples; walking between guesses would be a second smoother.
            if (!this.#predicted.has(local)) this.#sample(local, now);
        }
        for (const local of this.#corrections.keys()) this.#moved.add(local);
        // The frames between two samples had nothing to draw before.
        for (const [local, track] of this.#tracks) {
            if (track.settled) continue;
            // Patched once more, or an entity rests a fraction short of the authoritative pose.
            if (this.#renderTime >= track.to.time) track.settled = true;
            this.#moved.add(local);
        }
        if (this.#moved.size === 0) return;

        this.#patches.length = 0;
        for (const local of this.#moved) {
            const node = this.#nodeFor.get(local);
            if (node === undefined) continue;
            const patch: NodePatch = { id: node };
            this.#fillTransform(patch, local);
            this.#patches.push(patch);
        }
        if (this.#patches.length > 0) this.#renderer.updateNodes(this.#patches);
    }

    /** Eases `local` from drawn pose to simulated; the offset replaces rather than accumulates. */
    correct(local: EntityId, x: number, y: number, z: number): void {
        const existing = this.#corrections.get(local);
        if (existing === undefined) {
            this.#corrections.set(local, { x, y, z, remaining: CORRECTION_SMOOTH_SECONDS });
            return;
        }
        existing.x = x;
        existing.y = y;
        existing.z = z;
        existing.remaining = CORRECTION_SMOOTH_SECONDS;
    }

    /** Drops the ease, so the next push draws the simulation's own position. */
    clearCorrection(local: EntityId): void {
        this.#corrections.delete(local);
    }

    /** What is added to `local`'s drawn position, so a correction measures from the drawn pose. */
    correctionOf(local: EntityId): Correction {
        return this.#corrections.get(local) ?? NO_CORRECTION;
    }

    /** Where `local` is on screen now, whichever path owns it, so a camera follows what is seen. */
    drawnPosition(local: EntityId): { x: number; y: number; z: number } {
        const track = this.#trackFor(local);
        if (track !== undefined) {
            const { from, to } = track;
            const alpha = progress(from.time, to.time, this.#renderTime);
            return {
                x: lerp(from.x, to.x, alpha),
                y: lerp(from.y, to.y, alpha),
                z: lerp(from.z, to.z, alpha),
            };
        }
        const rt = this.#view.runtime;
        const offset = this.#corrections.get(local) ?? NO_CORRECTION;
        return {
            x: rt.transforms.posX(local) + offset.x,
            y: rt.transforms.posY(local) + offset.y,
            z: rt.transforms.posZ(local) + offset.z,
        };
    }

    /** The segment `local` is drawn along, or `undefined` when drawn from the simulation. */
    #trackFor(local: EntityId): Track | undefined {
        if (this.#predicted.has(local)) return undefined;
        return this.#tracks.get(local);
    }

    /** Records this frame's wire pose as a new segment's far end; the old far end becomes near. */
    #sample(local: EntityId, now: number): void {
        const track = this.#tracks.get(local);
        if (track === undefined) {
            // One sample is not a segment: the dirty set already drew this entity at that pose.
            this.#tracks.set(local, {
                from: this.#sampleOf(local, now),
                to: this.#sampleOf(local, now),
                settled: true,
            });
            return;
        }
        const from = track.to;
        const to = track.from;
        from.time = Math.max(from.time, this.#renderTime);
        this.#writeSample(to, local, now);
        track.from = from;
        track.to = to;
        track.settled = false;
    }

    #sampleOf(local: EntityId, time: number): Sample {
        const sample: Sample = {
            time,
            x: 0,
            y: 0,
            z: 0,
            rotation: 0,
            scale: 1,
            alpha: 1,
            layer: 0,
        };
        this.#writeSample(sample, local, time);
        return sample;
    }

    #writeSample(into: Sample, local: EntityId, time: number): void {
        const transforms = this.#view.runtime.transforms;
        into.time = time;
        into.x = transforms.posX(local);
        into.y = transforms.posY(local);
        into.z = transforms.posZ(local);
        into.rotation = transforms.rotation(local);
        into.scale = transforms.scale(local);
        into.alpha = transforms.opacity(local);
        into.layer = transforms.layer(local);
    }

    /** Ages every correction by one frame, shrinking the offset by the fraction of life passed. */
    #decay(nowSeconds: number): void {
        if (!Number.isFinite(nowSeconds)) return;
        const last = this.#lastNow;
        this.#lastNow = nowSeconds;
        if (last === undefined || this.#corrections.size === 0) return;

        const dt = Math.min(Math.max(0, nowSeconds - last), MAX_FRAME_DT);
        if (dt === 0) return;
        this.#expired.length = 0;
        for (const [local, correction] of this.#corrections) {
            const next = correction.remaining - dt;
            if (next <= 0) {
                this.#expired.push(local);
                continue;
            }
            const scale = next / correction.remaining;
            correction.x *= scale;
            correction.y *= scale;
            correction.z *= scale;
            correction.remaining = next;
        }
        for (const local of this.#expired) this.#corrections.delete(local);
        this.#expired.length = 0;
    }

    /** Unconditional: `applyView` is idempotent, and a missed change is a bug. */
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
        this.#entityFor.clear();
        this.#parentOf.clear();
        this.#childrenOf.clear();
        // Unlike the template table: an offset describes a node that no longer exists.
        this.#corrections.clear();
        // A resync would interpolate between two worlds: old stamps, respawned entities.
        this.#tracks.clear();
    }

    get nodeCount(): number {
        return this.#nodeFor.size;
    }

    nodeFor(local: EntityId): NodeId | undefined {
        return this.#nodeFor.get(local);
    }

    /** The entity a node stands for, or undefined; only an entity's ROOT node is in the map. */
    entityFor(node: NodeId): EntityId | undefined {
        return this.#entityFor.get(node);
    }

    #create(local: EntityId): void {
        if (this.#nodeFor.has(local)) return;
        const rt = this.#view.runtime;
        const template = this.#view.templateOf(local);
        const transform: TransformFields = {};
        this.#fillTransform(transform, local);
        const node = this.#rootNode(template, transform);
        this.#nodeFor.set(local, node);
        this.#entityFor.set(node, local);

        // After creation: the parent's node may be created in this same batch, spawn-order first.
        const parent = rt.entities.record(local)?.parent;
        if (parent !== undefined && parent !== NO_ENTITY) this.#attach(local, parent);
    }

    /** The node an entity maps to: `createNode` for a leaf, `createSubtree` for a group. */
    #rootNode(template: string, transform: TransformFields): NodeId {
        const batch = this.#subtreeFor.get(template);
        // Spread into a fresh object either way: a prebuilt desc is one object per template, and
        // writing this spawn's position into it would move every other entity drawing the same one.
        if (batch === undefined) {
            return this.#renderer.createNode({ ...this.#descFor(template), ...transform });
        }

        this.#batch.length = 0;
        this.#batch.push({ ...(batch[0] as SubtreeNodeDesc), ...transform });
        for (let i = 1; i < batch.length; i++) this.#batch.push(batch[i] as SubtreeNodeDesc);
        // Root first, by construction of the flatten. Empty only before `init`, where `createNode`
        // hands back `NO_NODE` too.
        return this.#renderer.createSubtree(this.#batch, this.#created)[0] ?? NO_NODE;
    }

    /** The transform as the renderer's five fields, filled into a caller-owned target. */
    #fillTransform(into: TransformFields, local: EntityId): void {
        const track = this.#trackFor(local);
        if (track !== undefined) {
            const { from, to } = track;
            const alpha = progress(from.time, to.time, this.#renderTime);
            const scale = lerp(from.scale, to.scale, alpha);
            into.position = {
                x: lerp(from.x, to.x, alpha),
                y: lerp(from.y, to.y, alpha),
                z: lerp(from.z, to.z, alpha),
            };
            into.rotation = lerpDegrees(from.rotation, to.rotation, alpha);
            into.scale = { x: scale, y: scale, z: 1 };
            into.alpha = lerp(from.alpha, to.alpha, alpha);
            // Draw order is discrete; the newer wins, so restacking is never buffered.
            into.layer = to.layer;
            return;
        }

        const rt = this.#view.runtime;
        const scale = rt.transforms.scale(local);
        const offset = this.#corrections.get(local) ?? NO_CORRECTION;
        into.position = {
            x: rt.transforms.posX(local) + offset.x,
            y: rt.transforms.posY(local) + offset.y,
            z: rt.transforms.posZ(local) + offset.z,
        };
        into.rotation = rt.transforms.rotation(local);
        into.scale = { x: scale, y: scale, z: 1 };
        into.alpha = rt.transforms.opacity(local);
        into.layer = rt.transforms.layer(local);
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

        // `destroyNode` cascades, but every descendant's map entry must go too, or a later spawn
        // reusing that EntityId finds a stale node.
        this.#doomed.length = 0;
        this.#doomed.push(local);
        for (let i = 0; i < this.#doomed.length; i++) {
            const children = this.#childrenOf.get(this.#doomed[i] as EntityId);
            if (children !== undefined) for (const child of children) this.#doomed.push(child);
        }

        this.#unlink(local);
        for (const id of this.#doomed) {
            const doomedNode = this.#nodeFor.get(id);
            if (doomedNode !== undefined) this.#entityFor.delete(doomedNode);
            this.#nodeFor.delete(id);
            this.#parentOf.delete(id);
            this.#childrenOf.delete(id);
            this.#corrections.delete(id);
            // A destroy is never delayed by the buffer, or it draws after the authority retired it.
            this.#tracks.delete(id);
        }
        this.#doomed.length = 0;

        this.#renderer.destroyNode(node);
    }

    /** A missing template draws a placeholder rather than being skipped. */
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

function lerp(from: number, to: number, alpha: number): number {
    return from + (to - from) * alpha;
}

/** Where `at` falls across `[from, to]`, clamped; the clamp at 1 holds rather than extrapolates. */
function progress(from: number, to: number, at: number): number {
    const span = to - from;
    if (!(span > 0)) return 1;
    return Math.min(Math.max((at - from) / span, 0), 1);
}

/** Degrees, the short way round: the authority may wrap, and 359°→1° is one degree forward. */
function lerpDegrees(from: number, to: number, alpha: number): number {
    const delta = ((((to - from) % 360) + 540) % 360) - 180;
    return from + delta * alpha;
}

/** A group template's art as one `createSubtree` batch, root first, or `undefined` if refused. */
function flattenGroup(visual: GroupTemplateVisual): SubtreeNodeDesc[] | undefined {
    const batch: SubtreeNodeDesc[] = [{ kind: 'group' }];
    return pushChildren(visual.children, 0, 1, batch) ? batch : undefined;
}

/** Appends one level of `children` under `parentInBatch`, then recurses. Bounds checked first. */
function pushChildren(
    children: TemplateChild[] | undefined,
    parentInBatch: number,
    depth: number,
    batch: SubtreeNodeDesc[],
): boolean {
    if (children === undefined) return true;
    if (depth > MAX_TEMPLATE_DEPTH) return false;
    if (!Array.isArray(children)) return false;
    if (children.length > MAX_WIRE_ITEMS) return false;
    if (batch.length + children.length > MAX_TEMPLATE_NODES) return false;

    for (const child of children) {
        if (batch.length >= MAX_TEMPLATE_NODES) return false;
        const desc = childDesc(child, parentInBatch);
        if (desc === undefined) return false;
        const at = batch.length;
        batch.push(desc);
        if (child.kind !== 'group') continue;
        if (!pushChildren(child.children, at, depth + 1, batch)) return false;
    }
    return true;
}

/** One wire child as a desc parented inside the batch, or `undefined`; `layer` is clamped here. */
function childDesc(child: TemplateChild, parentInBatch: number): SubtreeNodeDesc | undefined {
    if (typeof child !== 'object' || child === null) return undefined;
    const position = { x: child.offsetX ?? 0, y: child.offsetY ?? 0, z: child.offsetZ ?? 0 };

    if (child.kind === 'group') {
        const desc: SubtreeNodeDesc = { kind: 'group', parentInBatch, position };
        if (isFiniteNumber(child.layer)) desc.layer = child.layer;
        return desc;
    }
    if (child.kind !== 'sprite') return undefined;
    if (typeof child.texture !== 'string' || child.texture === '') return undefined;

    const desc: SubtreeNodeDesc = {
        kind: 'sprite',
        texture: child.texture,
        parentInBatch,
        position,
    };
    if (child.rotation !== undefined) desc.rotation = child.rotation;
    if (child.scale !== undefined) desc.scale = { x: child.scale, y: child.scale, z: 1 };
    if (child.alpha !== undefined) desc.alpha = child.alpha;
    if (child.anchorX !== undefined || child.anchorY !== undefined) {
        desc.anchor = { x: child.anchorX ?? 0.5, y: child.anchorY ?? 0.5, z: 0 };
    }
    if (child.tint !== undefined) desc.tint = child.tint;
    if (isFiniteNumber(child.layer)) desc.layer = child.layer;
    if (child.neverCull !== undefined) desc.neverCull = child.neverCull;
    return desc;
}

/** Core's kinds are not the renderer's; `audio`/`clip`/`effect` are not renderer assets. */
function toManifestEntry(ref: WireAssetRef): AssetManifestEntry[] {
    // Dropped, not passed on: the loader throws on an empty url.
    if (typeof ref.url !== 'string' || ref.url === '') return [];
    // The narrower remote set, not the loader's: `data:` and `blob:` are ours to construct, and a
    // server that can name one hands us bytes we never fetched.
    if (!isAllowedAssetUrl(ref.url, REMOTE_ASSET_SCHEMES)) return [];
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
