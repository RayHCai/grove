// The render bridge: the handle map, the per-frame transform push, the interpolation buffer, and the
// camera.
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
    SubtreeNodeDesc,
    AssetManifestEntry,
} from '@platform/renderer';
import { NO_NODE, REMOTE_ASSET_SCHEMES, isAllowedAssetUrl } from '@platform/renderer';
import type {
    GroupTemplateVisual,
    RenderManifest,
    TemplateChild,
    TemplateVisual,
    WireAssetRef,
} from '@platform/protocol';
import {
    CORRECTION_SMOOTH_SECONDS,
    MAX_FRAME_DT,
    MAX_INTERPOLATION_DELAY_SECONDS,
    MAX_TEMPLATE_DEPTH,
    MAX_TEMPLATE_NODES,
    MAX_WIRE_ITEMS,
} from './constants.js';
import type { MirrorDelta, MirrorView } from './mirror.js';

/** Never resident, so the renderer shows its own placeholder; a name it could reject would abort. */
const PLACEHOLDER_TEXTURE = '__missing__';

/** What a `NodeDesc` and a `NodePatch` spell identically, so one read can serve either. */
type TransformFields = Pick<NodePatch, 'position' | 'rotation' | 'scale' | 'alpha' | 'layer'>;

/** Nothing predicted until a `Prediction` says otherwise, so a client without one interpolates all of it. */
const NOTHING_PREDICTED: ReadonlySet<EntityId> = new Set();

/** One authoritative pose, stamped with the frame's own seconds — the base the whole file works in. */
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

/**
 * The two samples a buffered entity is drawn between, and whether the drawn pose has reached the later one.
 *
 * Two rather than a queue: the drawn moment trails the newest sample by one send interval, so the pair
 * bracketing it is always the newest pair, and a deeper history would only be read behind a longer delay —
 * which is the whole cost of the buffer. The pair is recycled rather than reallocated, since a sample lands
 * per entity per send.
 */
interface Track {
    from: Sample;
    to: Sample;
    /** The drawn pose is `to` and will not change again until a sample lands, so it needs no more patches. */
    settled: boolean;
}

/**
 * What is added to a drawn position right now, and the seconds left before it is nothing.
 *
 * The vector is decayed in place rather than scaled at every read, so a reader adds it and a second
 * reader — the camera — cannot disagree with the renderer about how far along the ease is.
 */
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
    /**
     * Keyed by EntityId, not netId, so the render layer never learns there is a network.
     *
     * One `GameClient` owns its renderer's node namespace exclusively — two on one `IRenderer` would each
     * believe they owned it, and neither would be wrong about its own nodes.
     */
    readonly #nodeFor = new Map<EntityId, NodeId>();
    readonly #templates = new Map<string, TemplateVisual>();

    /**
     * The group templates that draw a subtree, flattened once into a `createSubtree` batch.
     *
     * Root first, so a spawn overlays the entity's transform on entry 0 and passes the rest through
     * untouched — the wire's child list is walked at join, never per spawn.
     */
    readonly #subtreeFor = new Map<string, SubtreeNodeDesc[]>();

    /** Scratch, reused per spawn: `createSubtree` retains neither array past the call. */
    readonly #batch: SubtreeNodeDesc[] = [];
    readonly #created: NodeId[] = [];

    /**
     * The parenting this bridge applied, both directions, kept here rather than read back per destroy.
     *
     * Walking the renderer's `parentOf` for every entry in the node map costs one call per node per ancestor
     * level per destroyed entity, on a path inside the frame.
     */
    readonly #parentOf = new Map<EntityId, EntityId>();
    readonly #childrenOf = new Map<EntityId, Set<EntityId>>();

    /**
     * Display-only offsets, decaying to nothing — what reconciliation moved, eased.
     *
     * Never written back into the simulation: the server's answer is the one an input replays against,
     * and a drawn position is not a simulated one.
     */
    readonly #corrections = new Map<EntityId, Correction>();

    /**
     * The samples every entity prediction does not own is drawn between.
     *
     * A transform only changes when an envelope lands, so without this the send rate IS an entity's
     * visible motion rate: it holds its last pose for three to seven frames and then jumps.
     */
    readonly #tracks = new Map<EntityId, Track>();

    /**
     * What prediction owns, held live rather than copied — the set is refilled in place whenever
     * authoritative state lands, so membership here refreshes with it and needs no second notification.
     */
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

    /** `sendRate` is `Welcome`'s: the interval between transforms, and so the delay to draw behind. */
    constructor(renderer: IRenderer, view: MirrorView, sendRate: number) {
        this.#renderer = renderer;
        this.#view = view;
        // A non-finite or non-positive rate cannot reach here through `isUsableWelcome`, and falling back
        // to the cap keeps the buffer working for a caller that constructed one by hand.
        this.#delay =
            sendRate > 0
                ? Math.min(1 / sendRate, MAX_INTERPOLATION_DELAY_SECONDS)
                : MAX_INTERPOLATION_DELAY_SECONDS;
    }

    /**
     * Names the entities the buffer must leave alone: an entity is either predicted or interpolated.
     *
     * Both are smoothers — one eases a correction towards the authoritative pose, the other walks
     * between two of them — and an entity handed to both rubber-bands between them.
     */
    setPredicted(scope: ReadonlySet<EntityId>): void {
        this.#predicted = scope;
    }

    /**
     * Assets to `renderer.loadAssets`, templates into the table a spawn consults.
     *
     * The template loop runs before the first `await`, so a caller may start this and reconcile the join
     * snapshot without waiting; moving it after would draw a whole join as placeholders.
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
     * Drains the transform dirty set and patches what changed, what is still easing, and what is still
     * being interpolated towards a pose the wire already delivered.
     *
     * This is the only transform-channel consumer, which is what makes the dirty set a work queue rather
     * than a leak. Patching `liveIds()` instead would resend a few hundred unchanged entities every frame.
     * A correction outlives the movement that caused it, and so does a segment: both hold their entity in
     * the batch until they are spent — otherwise an avatar that stops the instant it is corrected freezes
     * part-way through, and a leaf reaches only part of the way to where the server put it.
     */
    pushTransforms(nowSeconds: number): void {
        const rt = this.#view.runtime;
        this.#decay(nowSeconds);
        // `#decay` stored it and discarded a non-finite one, which must never reach a sample stamp: every
        // alpha computed from a `NaN` time is `NaN`, and a `NaN` position draws at the origin.
        const now = this.#lastNow ?? 0;
        this.#renderTime = now - this.#delay;

        // Indices, not ids. A released slot reads as `NO_ENTITY`: an entity destroyed in the frame it moved
        // leaves its index dirty and its slot empty.
        rt.transforms.consumeDirty(this.#dirty);

        this.#moved.clear();
        for (const index of this.#dirty) {
            const local = rt.entities.idAt(index);
            if (local === NO_ENTITY) continue;
            this.#moved.add(local);
            // Only the wire's poses are samples. A predicted one is this client's own guess, and a buffer
            // walking between guesses would be a second smoother on an entity that already has one.
            if (!this.#predicted.has(local)) this.#sample(local, now);
        }
        for (const local of this.#corrections.keys()) this.#moved.add(local);
        // The frames between two samples are the ones that had nothing to draw before, which is the whole
        // difference between interpolating and stepping.
        for (const [local, track] of this.#tracks) {
            if (track.settled) continue;
            // Marked on the frame the drawn moment reaches `to`, and patched once more here: without the
            // last patch an entity comes to rest a fraction short of the pose the authority named.
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

    /**
     * Starts easing `local` from where it was drawn towards where the simulation now says it is.
     *
     * The offset replaces rather than accumulates, which is why the caller measures from the **drawn**
     * pose: the gap it hands over already contains whatever was still easing, and adding a second full
     * offset on top would count that residual twice.
     */
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

    /** What is currently added to `local`'s drawn position, so a correction measures from the drawn pose. */
    correctionOf(local: EntityId): Correction {
        return this.#corrections.get(local) ?? NO_CORRECTION;
    }

    /**
     * Where `local` is on screen right now, whichever path owns it — so a camera follows what a player sees.
     *
     * A camera locked to the simulated pose slides its target across the screen: while a predicted entity
     * eases towards a correction, and permanently by one send interval for an entity the buffer draws.
     */
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

    /**
     * The segment `local` is drawn along, or `undefined` when it is drawn from the simulation instead.
     *
     * The scope is asked rather than the map trusted to be empty: an entity that enters the predicted scope
     * keeps whatever track it had, and nothing samples it afterwards to expire one.
     */
    #trackFor(local: EntityId): Track | undefined {
        if (this.#predicted.has(local)) return undefined;
        return this.#tracks.get(local);
    }

    /**
     * Records the pose the wire delivered this frame as the far end of a new segment.
     *
     * The old far end becomes the new near end, and its stamp is pulled forward to the drawn moment when the
     * drawn pose had already caught up to it — an entity that stood still for a second would otherwise open
     * its next segment a second in the past and cross almost all of it on one frame.
     */
    #sample(local: EntityId, now: number): void {
        const track = this.#tracks.get(local);
        if (track === undefined) {
            // One sample is not a segment: there is nothing to walk towards yet, and the dirty set has
            // already put this entity in the batch, so it is drawn at that pose and left alone.
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

    /**
     * Ages every correction by one frame, shrinking the offset by the fraction of its life that passed.
     *
     * The clamp is the clock's: a backgrounded tab hands back a multi-second `dt`, and a decay that
     * consumed it would be indistinguishable from one that never ran. A non-finite `now` is discarded
     * rather than stored, or every later difference is `NaN` and a `NaN` position draws at the origin.
     */
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
        // Unlike the template table, which survives: an offset describes a node that no longer exists.
        this.#corrections.clear();
        // A resync comes through here, and a segment across one interpolates between two worlds — the
        // stamps belong to a session that has ended and the poses to entities the fresh snapshot respawns.
        this.#tracks.clear();
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
        const template = this.#view.templateOf(local);
        const transform: TransformFields = {};
        this.#fillTransform(transform, local);
        const node = this.#rootNode(template, transform);
        this.#nodeFor.set(local, node);

        // After creation: the parent's node may be created in this same batch, spawn-order first.
        const parent = rt.entities.record(local)?.parent;
        if (parent !== undefined && parent !== NO_ENTITY) this.#attach(local, parent);
    }

    /**
     * The node an entity maps to: one `createNode` for a leaf template, one `createSubtree` for a
     * group template that draws children.
     *
     * Only entry 0 is rebuilt per spawn — the descendants are shared by every entity of the template,
     * which is sound because the renderer retains no desc past the call.
     */
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

    /**
     * The transform to draw as the renderer's five fields, written into a caller-owned target.
     *
     * Fills rather than returns, so the per-frame path allocates one patch per moved entity and no
     * intermediate. Core stores one uniform scale; the renderer wants three axes. This is the one place a
     * drawn pose is allowed to differ from a simulated one — by a segment the buffer is walking, or by a
     * correction still easing, never by both.
     */
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
            // Draw order is discrete, and a fraction of a layer is not a layer. The newer wins, so a
            // restacking is never held behind a position the buffer is still walking towards.
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
            this.#corrections.delete(id);
            // A destroy is never delayed by the buffer: an entity held back for a send interval would draw
            // for another frame after the authority retired it.
            this.#tracks.delete(id);
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

function lerp(from: number, to: number, alpha: number): number {
    return from + (to - from) * alpha;
}

/**
 * Where `at` falls across `[from, to]`, clamped to it.
 *
 * The clamp at 1 is the whole answer to a sample that did not arrive: the drawn pose holds at the newest
 * one the authority sent rather than extrapolating past it. Extrapolating would draw a pose nobody
 * simulated on every entity that stopped, and take it back on the next sample; holding costs one send
 * interval of the motion the buffer exists to hide, and only on a send that was actually late.
 */
function progress(from: number, to: number, at: number): number {
    const span = to - from;
    if (!(span > 0)) return 1;
    return Math.min(Math.max((at - from) / span, 0), 1);
}

/**
 * Degrees, the short way round, because the authority is free to wrap the angle it sends.
 *
 * A spinner crossing 359° to 1° moved one degree forward; interpolating the raw numbers draws 358
 * degrees backwards instead, once per revolution.
 */
function lerpDegrees(from: number, to: number, alpha: number): number {
    const delta = ((((to - from) % 360) + 540) % 360) - 180;
    return from + delta * alpha;
}

/**
 * A group template's art as one `createSubtree` batch, root first, or `undefined` when the wire's
 * child list is beyond what this client will walk or names something the renderer would throw on.
 *
 * Refusing beats repairing: the renderer treats a sprite with no texture as a caller bug and throws,
 * and a throw from inside a spawn unwinds the frame and fails the session as a hostile peer.
 */
function flattenGroup(visual: GroupTemplateVisual): SubtreeNodeDesc[] | undefined {
    const batch: SubtreeNodeDesc[] = [{ kind: 'group' }];
    return pushChildren(visual.children, 0, 1, batch) ? batch : undefined;
}

/**
 * Appends one level of `children` under the batch entry at `parentInBatch`, then recurses.
 *
 * Depth and cardinality are checked BEFORE the level is walked and before any node of it is built,
 * because both the validation and the work behind it are linear in a count the peer chose. The total
 * is checked per push as well as up front: a sibling's own descendants land between this level's
 * pushes, so the entry check alone lets a deep list overshoot by one subtree per ancestor. Recursion
 * is sound only because of the depth bound.
 */
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

/**
 * One wire child as a desc parented inside the batch, or `undefined` when it is not one.
 *
 * A non-finite number is left alone, because the renderer clamps every value it stores — except
 * `layer`, which reaches a node's record straight from the desc and would then poison the sibling
 * sort, so it is the one number checked here.
 */
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

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/** Core's kinds are not the renderer's, and `audio`/`clip`/`effect` are not renderer assets at all. */
function toManifestEntry(ref: WireAssetRef): AssetManifestEntry[] {
    // Dropped, not passed on: the loader rejects an empty url by throwing, and one bad manifest row
    // must not take the rest of the manifest with it. A missing url is untyped wire data, not a string.
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
