// Everything both backends share, in one copy: the two stores, handle validation, the validation
// order the contract asserts, hierarchy, the resolve/flush/cull pass, projection and bounds,
// non-GPU asset bookkeeping, and the event emitter.
//
// Anything touching a display object or a GPU resource goes through `SceneSink` instead, and a
// backend is the only place a Pixi type may appear. Before this class existed the two backends had
// already drifted: the headless cull path ignored surface visibility while the Pixi one skipped
// hidden surfaces, and only one backend was under test.

import type { Bounds, MutableVec3, Size, Vec3Like } from '@platform/math';
import {
    bounds,
    boundsCopy,
    boundsEqual,
    boundsSet,
    finiteOr,
    positiveOr,
    vec3,
    vec3Set,
} from '@platform/math';
import type {
    CameraState,
    ContextState,
    InspectOptions,
    NodeDesc,
    NodePatch,
    NodeSnapshot,
    RendererEvents,
    RendererInitOptions,
    SceneSnapshot,
    ScaleMode,
    SubtreeNodeDesc,
    Surface,
    Transform,
    UiAnchor,
} from '../renderer.js';
import type { NodeId } from '../node-id.js';
import { NO_NODE } from '../node-id.js';
import { rendererError } from '../errors.js';
import { DEFAULT_SURFACES, isCameraTransformed, isSurface, surfaceOrder } from '../surfaces.js';
import type { NodeKind, NodeRecord } from '../node-store.js';
import { NodeStore } from '../node-store.js';
import { TransformStore } from '../transform-store.js';
import {
    DEFAULT_CULL_MARGIN,
    emptyLocalBounds,
    isVisibleInViewport,
    spriteLocalBounds,
    worldAabb,
} from '../bounds.js';
import { fitScale, stageRect, worldViewport } from '../viewport.js';
import { screenToWorld, uiToScreen, worldToScreen } from '../projection.js';
import type { SceneSink } from './scene-sink.js';
import { NO_PARENT } from './scene-sink.js';

type EventName = keyof RendererEvents;

/** Resolved init options, after defaults. */
interface CoreConfig {
    design: Size;
    canvas: Size;
    scaleMode: ScaleMode;
    letterbox: boolean;
    cullMargin: number;
    resolution: number;
    enabledSurfaces: Surface[];
}

/** Validates raw init options and applies every default, so both backends reject the same inputs. */
export function resolveInitOptions(
    options: RendererInitOptions,
    canvas: Size,
    resolution: number,
): CoreConfig {
    if (!(options.design.width > 0) || !(options.design.height > 0)) {
        rendererError('invalid-option', 'design must have a positive width and height');
    }
    if (options.maxResolution !== undefined && !(options.maxResolution > 0)) {
        rendererError('invalid-option', 'maxResolution must be positive');
    }
    if (options.cullMargin !== undefined && options.cullMargin < 0) {
        rendererError('invalid-option', 'cullMargin must not be negative');
    }
    // Deduped and checked, because an unrecognised string would otherwise pass `isSurfaceEnabled`
    // and let `createNode` place a node on a surface no backend built a root for.
    const enabledSurfaces = [...new Set(options.enabledSurfaces ?? DEFAULT_SURFACES)];
    for (const surface of enabledSurfaces) {
        if (!isSurface(surface)) {
            rendererError('invalid-option', `'${String(surface)}' is not a surface`);
        }
    }

    return {
        design: { width: options.design.width, height: options.design.height },
        canvas: { width: canvas.width, height: canvas.height },
        scaleMode: options.scaleMode ?? 'fit',
        letterbox: options.letterbox ?? true,
        cullMargin: options.cullMargin ?? DEFAULT_CULL_MARGIN,
        resolution,
        enabledSurfaces,
    };
}

/** A backend owns one of these plus a {@link SceneSink}, and forwards its `IRenderer` calls here. */
export class RendererCore {
    readonly nodes = new NodeStore();
    readonly xf = new TransformStore();

    #sink: SceneSink;
    #config: CoreConfig;
    #camera: CameraState = { position: { x: 0, y: 0, z: 0 }, zoom: 1, framing: 'stage' };

    readonly #listeners = new Map<EventName, Set<(e: never) => void>>();

    // Scratch, so the per-frame path allocates nothing.
    readonly #stage: Bounds = bounds();
    readonly #viewport: Bounds = bounds();
    readonly #scratchLocal: Bounds = bounds();
    readonly #scratchWorld: Bounds = bounds();
    readonly #scratchIndices: number[] = [];
    readonly #dirtyOut: number[] = [];
    readonly #resolvedOut: number[] = [];
    readonly #subtreeOut: number[] = [];
    readonly #liveOut: number[] = [];
    readonly #rootsOut: number[] = [];

    /** The viewport the last cull pass decided against, so a moved camera reconsiders everything. */
    readonly #culledViewport: Bounds = bounds();

    /** Set when something scene-wide changed and the next flush must reconsider every node. */
    #cullAll = true;

    /** Slots already re-culled this flush: a moved node lands in both dirty sets. */
    readonly #culledThisFlush = new Set<number>();

    constructor(sink: SceneSink, config: CoreConfig) {
        this.#sink = sink;
        this.#config = config;
        this.recomputeRects();
    }

    get config(): Readonly<CoreConfig> {
        return this.#config;
    }

    get canvasSize(): Readonly<Size> {
        return this.#config.canvas;
    }

    get resolution(): number {
        return this.#config.resolution;
    }

    // Copied, not the live rect: `recomputeRects` overwrites these in place every frame, so a
    // caller holding one would watch it rewrite itself and could never detect a change.

    get stageRect(): Readonly<Bounds> {
        return boundsCopy(bounds(), this.#stage);
    }

    get viewport(): Readonly<Bounds> {
        return boundsCopy(bounds(), this.#viewport);
    }

    get camera(): Readonly<CameraState> {
        return this.#camera;
    }

    setCanvasSize(width: number, height: number): void {
        this.#config.canvas = { width: Math.max(0, width), height: Math.max(0, height) };
        this.recomputeRects();
        this.applyView();
    }

    setCamera(camera: Readonly<CameraState>): void {
        // Copied, not retained, since a caller may reuse one camera object every frame. Never
        // clamped to `camera.bounds`, which is engine-enforced — but non-finite values are
        // rejected here, because a NaN reaching the backend blanks every camera-transformed
        // surface with no trace of where it came from.
        this.#camera = {
            position: {
                x: finiteOr(camera.position.x, 0),
                y: finiteOr(camera.position.y, 0),
                z: finiteOr(camera.position.z ?? 0, 0),
            },
            zoom: positiveOr(camera.zoom, 1),
            framing: camera.framing ?? 'stage',
        };
        this.recomputeRects();
        this.applyView();
    }

    isSurfaceEnabled(surface: Surface): boolean {
        return this.#config.enabledSurfaces.includes(surface);
    }

    setSurfaceVisible(surface: Surface, visible: boolean): void {
        // A disabled surface is a silent no-op; only `createNode` treats one as a caller bug.
        if (!this.isSurfaceEnabled(surface)) return;
        this.#sink.setSurfaceVisible(surface, visible);
        // Visibility feeds the cull decision for every node on that surface.
        this.#cullAll = true;
    }

    recomputeRects(): void {
        const { scaleMode, canvas, design, letterbox } = this.#config;
        stageRect(this.#camera.framing ?? 'stage', scaleMode, canvas, design, this.#stage);
        worldViewport(this.#camera, scaleMode, letterbox, canvas, design, this.#viewport);
    }

    applyView(): void {
        const { scaleMode, canvas, design, letterbox } = this.#config;
        this.#sink.applyView(this.#camera, scaleMode, canvas, design, this.#stage, letterbox);
    }

    fitScale(): number {
        const { scaleMode, canvas, design } = this.#config;
        return fitScale(this.#camera.framing ?? 'stage', scaleMode, canvas, design);
    }

    /**
     * Validates and allocates a node.
     *
     * The order of the checks is part of the contract — surface, then text-on-camera-surface, then
     * texture, then parent — because reordering them changes which error a caller sees.
     */
    createNode(desc: NodeDesc): NodeId {
        const surface = desc.surface ?? 'world';
        if (!this.isSurfaceEnabled(surface)) {
            rendererError(
                'surface-disabled',
                `surface '${surface}' is not in enabledSurfaces; check isSurfaceEnabled() first`,
            );
        }
        if (desc.kind === 'text' && isCameraTransformed(surface)) {
            rendererError(
                'text-node-on-world-surface',
                `kind: 'text' is UI-only; for world text call createTextAsset(name, text) and ` +
                    `create a sprite node with that texture`,
            );
        }
        if (desc.kind === 'sprite' && desc.texture === '') {
            rendererError('invalid-node-desc', 'a sprite node needs a non-empty texture name');
        }

        const parentIndex = this.#resolveParent(desc.parent, surface);

        const record: NodeRecord = {
            kind: desc.kind as NodeKind,
            surface,
            texture: desc.kind === 'sprite' ? desc.texture : '',
            text: desc.kind === 'text' ? desc.text : '',
            style: desc.kind === 'text' ? desc.style : undefined,
            uiAnchor: desc.uiAnchor,
            layer: desc.layer ?? 0,
        };

        const id = this.nodes.create(record);
        const index = this.nodes.indexOf(id);
        this.xf.initSlot(index);

        if (desc.position !== undefined) this.#writePosition(index, desc.position);
        if (desc.visible !== undefined) this.xf.setVisible(index, desc.visible);
        if (desc.rotation !== undefined) this.xf.setRotation(index, finiteOr(desc.rotation, 0));
        if (desc.scale !== undefined) this.#writeScale(index, desc.scale);
        if (desc.alpha !== undefined) this.xf.setAlpha(index, finiteOr(desc.alpha, 1));
        if (desc.anchor !== undefined) this.#writeAnchor(index, desc.anchor);
        if (desc.tint !== undefined) this.xf.setTint(index, finiteOr(desc.tint, 0xffffff));
        if (desc.neverCull !== undefined) this.xf.setNeverCull(index, desc.neverCull);
        if (parentIndex >= 0) this.xf.link(index, parentIndex);

        this.#sink.create(index, record, parentIndex);
        return id;
    }

    destroyNode(id: NodeId): void {
        const index = this.nodes.indexOf(id);
        // A stale handle is a legitimate race — `entity.destroy()` mid-frame — so it no-ops.
        if (index < 0) return;

        const subtree = this.xf.subtree(index, this.#subtreeOut, true);
        this.#sink.destroySubtree(subtree);

        // Deepest first, so a released slot is never a live node's parent.
        for (let i = subtree.length - 1; i >= 0; i--) {
            const slot = subtree[i] as number;
            this.xf.releaseSlot(slot);
            this.nodes.release(slot);
        }
    }

    updateNodes(patches: readonly NodePatch[]): void {
        // Retains nothing past the call — not the array, not any patch object.
        for (const patch of patches) {
            const index = this.nodes.indexOf(patch.id);
            if (index < 0) continue;
            const record = this.nodes.recordAt(index);
            if (record === null) continue;

            if (patch.parent !== undefined) {
                if (patch.parent === NO_NODE) this.detachAt(index, true);
                else this.attachAt(index, patch.parent, false);
            }
            this.#applyPatchAt(index, record, patch);
        }
    }

    updateSubtree(
        root: NodeId,
        patch: Omit<NodePatch, 'id' | 'parent'>,
        opts?: { includeRoot?: boolean },
    ): void {
        const index = this.nodes.indexOf(root);
        if (index < 0) return;

        const includeRoot = opts?.includeRoot ?? true;
        // Set-only, establishing no inheritance, so a node attached later is unaffected — and
        // `{alpha: 0.5}` flattens a subtree that had varied alphas.
        //
        // Applied by slot rather than through `updateNodes`, which would pack a handle per node
        // only to unpack it again and allocate a patch object per node to carry it.
        for (const slot of this.xf.subtree(index, this.#subtreeOut, includeRoot)) {
            const record = this.nodes.recordAt(slot);
            if (record === null) continue;
            this.#applyPatchAt(slot, record, patch);
        }
    }

    /** Applies every field a patch sets, for a slot whose record is already in hand. */
    #applyPatchAt(
        index: number,
        record: NodeRecord,
        patch: Omit<NodePatch, 'id' | 'parent'>,
    ): void {
        if (patch.position !== undefined) this.#writePosition(index, patch.position);
        if (patch.rotation !== undefined) this.xf.setRotation(index, finiteOr(patch.rotation, 0));
        if (patch.scale !== undefined) this.#writeScale(index, patch.scale);
        if (patch.anchor !== undefined) this.#writeAnchor(index, patch.anchor);
        if (patch.alpha !== undefined) this.xf.setAlpha(index, finiteOr(patch.alpha, 1));
        if (patch.visible !== undefined) this.xf.setVisible(index, patch.visible);
        if (patch.tint !== undefined) this.xf.setTint(index, finiteOr(patch.tint, 0xffffff));
        if (patch.layer !== undefined) {
            record.layer = finiteOr(patch.layer, 0);
            this.#sink.setLayer(index, record.layer);
        }
        // A wrong-shaped patch comes from generic client code, not from a caller bug worth
        // throwing over, so a `texture` on a non-sprite is ignored.
        if (patch.texture !== undefined && record.kind === 'sprite') {
            record.texture = patch.texture;
            this.#sink.setTexture(index, record);
            // A different texture is a different size, so the cull answer has to be revisited.
            this.xf.markFlushDirty(index);
        }
        if (patch.text !== undefined && record.kind === 'text') {
            record.text = patch.text;
            this.#sink.setText(index, patch.text);
            this.xf.markFlushDirty(index);
        }
    }

    // A non-finite authored value would compose into every resolved position beneath it and reach
    // the backend as a blank surface, so it is rejected at the boundary rather than in the store.

    #writePosition(index: number, position: Vec3Like): void {
        this.xf.setPosition(
            index,
            finiteOr(position.x, 0),
            finiteOr(position.y, 0),
            finiteOr(position.z ?? 0, 0),
        );
    }

    #writeScale(index: number, scale: Vec3Like): void {
        this.xf.setScale(
            index,
            finiteOr(scale.x, 1),
            finiteOr(scale.y, 1),
            finiteOr(scale.z ?? 1, 1),
        );
    }

    #writeAnchor(index: number, anchor: Vec3Like): void {
        this.xf.setAnchor(index, finiteOr(anchor.x, 0.5), finiteOr(anchor.y, 0.5));
    }

    setNodeText(id: NodeId, text: string): void {
        const index = this.nodes.indexOf(id);
        if (index < 0) return;
        const record = this.nodes.recordAt(index);
        // World text is an asset, so changing it means a new text asset and a texture swap.
        if (record === null || record.kind !== 'text') return;
        record.text = text;
        this.#sink.setText(index, text);
        this.xf.markFlushDirty(index);
    }

    clear(surface?: Surface): void {
        if (surface === undefined) {
            this.#sink.clearAll();
            this.nodes.clear();
            this.xf.clear();
            return;
        }
        // Roots only; each destroy cascades, so a child is never visited twice.
        for (const slot of this.nodes.liveIndices()) {
            const record = this.nodes.recordAt(slot);
            if (record?.surface !== surface) continue;
            if (this.xf.parent(slot) !== NO_PARENT) continue;
            this.destroyNode(this.nodes.idAt(slot));
        }
    }

    /**
     * `attachNode`, handle lookup and default included.
     *
     * `keepResolvedPosition` defaults to false here and true in {@link detachNode}: the asymmetry
     * matches the creator API, where `attachTo` reinterprets and `detach` preserves.
     */
    attachNode(child: NodeId, parent: NodeId, opts?: { keepResolvedPosition?: boolean }): void {
        const index = this.nodes.indexOf(child);
        if (index < 0) return;
        this.attachAt(index, parent, opts?.keepResolvedPosition ?? false);
    }

    /** `detachNode`, defaulting `keepResolvedPosition` to true — it keeps world position. */
    detachNode(child: NodeId, opts?: { keepResolvedPosition?: boolean }): void {
        const index = this.nodes.indexOf(child);
        if (index < 0) return;
        this.detachAt(index, opts?.keepResolvedPosition ?? true);
    }

    /** Creates a batch. No intra-batch parenting — a `parent` must already exist. */
    createNodes(descs: readonly NodeDesc[], out: NodeId[] = []): NodeId[] {
        out.length = 0;
        for (const desc of descs) out.push(this.createNode(desc));
        return out;
    }

    /**
     * Creates a whole subtree, resolving each `parentInBatch` against the nodes this call made.
     *
     * Rolled back rather than pre-validated on a throw: the checks and their order belong to
     * {@link createNode}, and a second copy here would answer differently the day one moves.
     */
    createSubtree(descs: readonly SubtreeNodeDesc[], out: NodeId[] = []): NodeId[] {
        out.length = 0;
        try {
            for (let at = 0; at < descs.length; at++) {
                out.push(this.#createInBatch(descs[at] as SubtreeNodeDesc, at, out));
            }
        } catch (error) {
            // Deepest first, so a released slot is never a live node's parent.
            for (let i = out.length - 1; i >= 0; i--) this.destroyNode(out[i] as NodeId);
            out.length = 0;
            throw error;
        }
        return out;
    }

    /** One desc of a {@link createSubtree} batch, its parent read out of `created`. */
    #createInBatch(desc: SubtreeNodeDesc, at: number, created: readonly NodeId[]): NodeId {
        const parentAt = desc.parentInBatch;
        if (parentAt === undefined) return this.createNode(desc);
        if (!Number.isInteger(parentAt) || parentAt < 0 || parentAt >= at) {
            rendererError(
                'invalid-node-desc',
                `parentInBatch ${String(parentAt)} must name an earlier desc in the same batch`,
            );
        }
        const parent = created[parentAt] as NodeId;
        const child: NodeDesc = { ...desc };
        child.parent = parent;
        // Inherited rather than defaulted to `'world'`, which would be a cross-surface throw for
        // every subtree that is not on the world surface.
        child.surface = desc.surface ?? this.surfaceOf(parent) ?? 'world';
        return this.createNode(child);
    }

    attachAt(index: number, parent: NodeId, keepResolvedPosition: boolean): void {
        const parentIndex = this.nodes.indexOf(parent);
        if (parentIndex < 0) return;

        const childRecord = this.nodes.recordAt(index);
        const parentRecord = this.nodes.recordAt(parentIndex);
        if (childRecord === null || parentRecord === null) return;
        if (childRecord.surface !== parentRecord.surface) {
            rendererError(
                'cross-surface-parent',
                `cannot parent a '${childRecord.surface}' node to a '${parentRecord.surface}' node`,
            );
        }
        if (this.xf.isAncestorOf(index, parentIndex)) {
            rendererError('cycle', 'that parenting would make a node its own ancestor');
        }

        this.#relinkAt(index, parentIndex, keepResolvedPosition);
        this.#sink.reparent(index, childRecord, parentIndex);
    }

    detachAt(index: number, keepResolvedPosition: boolean): void {
        if (this.xf.parent(index) === NO_PARENT) return;
        this.#relinkAt(index, NO_PARENT, keepResolvedPosition);

        const record = this.nodes.recordAt(index);
        if (record !== null) this.#sink.reparent(index, record, NO_PARENT);
    }

    /**
     * Relinks a slot under `parentIndex` — {@link NO_PARENT} detaches — and, when asked, rewrites
     * its local position so the resolved one survives the move.
     */
    #relinkAt(index: number, parentIndex: number, keepResolvedPosition: boolean): void {
        if (!keepResolvedPosition) {
            if (parentIndex === NO_PARENT) this.xf.unlink(index);
            else this.xf.link(index, parentIndex);
            return;
        }

        this.xf.resolve();
        const wantX = this.xf.resolvedX(index);
        const wantY = this.xf.resolvedY(index);
        const wantZ = this.xf.resolvedZ(index);

        if (parentIndex === NO_PARENT) {
            this.xf.unlink(index);
            // A root's local position IS its resolved one, so there is nothing to subtract.
            this.xf.setPosition(index, wantX, wantY, wantZ);
            return;
        }

        this.xf.link(index, parentIndex);
        this.xf.resolve();
        // Only position inherits, so preserving one is subtraction, not a matrix.
        this.xf.setPosition(
            index,
            wantX - this.xf.resolvedX(parentIndex),
            wantY - this.xf.resolvedY(parentIndex),
            wantZ - this.xf.resolvedZ(parentIndex),
        );
    }

    parentOf(id: NodeId): NodeId {
        const index = this.nodes.indexOf(id);
        if (index < 0) return NO_NODE;
        const parent = this.xf.parent(index);
        return parent === NO_PARENT ? NO_NODE : this.nodes.idAt(parent);
    }

    childrenOf(id: NodeId, out: NodeId[] = []): NodeId[] {
        out.length = 0;
        const index = this.nodes.indexOf(id);
        if (index < 0) return out;
        for (const slot of this.xf.children(index, this.#scratchIndices)) {
            const childId = this.nodes.idAt(slot);
            if (childId !== NO_NODE) out.push(childId);
        }
        return out;
    }

    surfaceOf(id: NodeId): Surface | null {
        const index = this.nodes.indexOf(id);
        if (index < 0) return null;
        return this.nodes.recordAt(index)?.surface ?? null;
    }

    localTransformOf(id: NodeId, out?: Transform): Transform | null {
        const index = this.nodes.indexOf(id);
        if (index < 0) return null;
        const t = out ?? blankTransform();
        vec3Set(t.position, this.xf.posX(index), this.xf.posY(index), this.xf.posZ(index));
        t.rotation = this.xf.rotation(index);
        vec3Set(t.scale, this.xf.scaleX(index), this.xf.scaleY(index), this.xf.scaleZ(index));
        t.alpha = this.xf.alpha(index);
        t.visible = this.xf.visible(index);
        return t;
    }

    resolvedTransformOf(id: NodeId, out?: Transform): Transform | null {
        const index = this.nodes.indexOf(id);
        if (index < 0) return null;
        this.xf.resolve();
        const t = out ?? blankTransform();
        vec3Set(
            t.position,
            this.xf.resolvedX(index),
            this.xf.resolvedY(index),
            this.xf.resolvedZ(index),
        );
        // For rotation, scale and alpha local is resolved, since they do not inherit.
        t.rotation = this.xf.rotation(index);
        vec3Set(t.scale, this.xf.scaleX(index), this.xf.scaleY(index), this.xf.scaleZ(index));
        t.alpha = this.xf.alpha(index);
        t.visible = this.xf.resolvedVisible(index);
        return t;
    }

    localBoundsOf(id: NodeId): Bounds | null {
        const index = this.nodes.indexOf(id);
        if (index < 0) return null;
        return boundsCopy(bounds(), this.localBoundsAt(index, this.#scratchLocal));
    }

    worldBoundsOf(id: NodeId): Bounds | null {
        const index = this.nodes.indexOf(id);
        if (index < 0) return null;
        this.xf.resolve();
        return boundsCopy(bounds(), this.worldBoundsAt(index, this.#scratchWorld));
    }

    screenBoundsOf(id: NodeId): Bounds | null {
        const index = this.nodes.indexOf(id);
        if (index < 0) return null;
        const record = this.nodes.recordAt(index);
        if (record === null) return null;
        this.xf.resolve();

        if (!isCameraTransformed(record.surface)) {
            // UI: the anchor origin plus the design-px offset, already in screen space (y-down).
            const origin = this.#uiScreenPosition(index, vec3());
            const local = this.localBoundsAt(index, this.#scratchLocal);
            const scale = this.fitScale();
            return boundsSet(
                bounds(),
                origin.x + local.left * scale,
                origin.x + local.right * scale,
                // Local bounds are y-up; screen is y-down, so `top` takes the -local.top side.
                origin.y - local.top * scale,
                origin.y - local.bottom * scale,
            );
        }

        const world = this.worldBoundsAt(index, this.#scratchWorld);
        const topLeft = this.worldToScreen({ x: world.left, y: world.top }, vec3());
        const bottomRight = this.worldToScreen({ x: world.right, y: world.bottom }, vec3());
        // y-down after projection: `bottom > top`.
        return boundsSet(bounds(), topLeft.x, bottomRight.x, topLeft.y, bottomRight.y);
    }

    screenPositionOf(id: NodeId, out: MutableVec3 = vec3()): MutableVec3 | null {
        const index = this.nodes.indexOf(id);
        if (index < 0) return null;
        const record = this.nodes.recordAt(index);
        if (record === null) return null;
        this.xf.resolve();

        if (!isCameraTransformed(record.surface)) {
            return this.#uiScreenPosition(index, out);
        }
        return this.worldToScreen(
            {
                x: this.xf.resolvedX(index),
                y: this.xf.resolvedY(index),
                z: this.xf.resolvedZ(index),
            },
            out,
        );
    }

    worldToScreen(point: Vec3Like, out: MutableVec3 = vec3()): MutableVec3 {
        const { scaleMode, canvas, design } = this.#config;
        return worldToScreen(point, this.#camera, scaleMode, canvas, design, out);
    }

    screenToWorld(point: Vec3Like, out: MutableVec3 = vec3()): MutableVec3 {
        const { scaleMode, canvas, design } = this.#config;
        return screenToWorld(point, this.#camera, scaleMode, canvas, design, out);
    }

    localBoundsAt(index: number, out: Bounds): Bounds {
        const record = this.nodes.recordAt(index);
        // A group has no art, so it has no extent and is never culled.
        if (record === null || record.kind === 'group') return emptyLocalBounds(out);

        return spriteLocalBounds(
            this.#sink.sizeOf(index, record),
            this.xf.scaleX(index),
            this.xf.scaleY(index),
            this.xf.anchorX(index),
            this.xf.anchorY(index),
            out,
        );
    }

    worldBoundsAt(index: number, out: Bounds): Bounds {
        const local = this.localBoundsAt(index, this.#scratchLocal);
        return worldAabb(
            local,
            // Its own rotation: rotation does not inherit, so there is no ancestor walk.
            this.xf.rotation(index),
            this.xf.resolvedX(index),
            this.xf.resolvedY(index),
            out,
        );
    }

    /**
     * Resolves the store, pushes dirtied local values, then recomputes cull flags.
     *
     * Called by a backend's `render()`. Draws nothing itself — a backend presents afterwards.
     *
     * The cull pass is O(dirty), not O(scene): a node's cull answer can only change if its own
     * values changed, if its resolved position moved, or if the viewport did. A full scan every
     * frame re-decided an answer that had not changed for every node in the scene, allocating an
     * index array as it went.
     */
    flush(): void {
        this.xf.resolve();

        const dirty = this.xf.consumeFlushDirty(this.#dirtyOut);
        for (const index of dirty) {
            const record = this.nodes.recordAt(index);
            if (record === null) continue;
            this.#sink.write(index, record);
        }

        if (!boundsEqual(this.#culledViewport, this.#viewport)) {
            boundsCopy(this.#culledViewport, this.#viewport);
            this.#cullAll = true;
        }

        if (this.#cullAll) {
            this.#cullAll = false;
            for (const index of this.nodes.liveIndices(this.#liveOut)) this.#cull(index);
            this.xf.consumeResolvedDirty(this.#resolvedOut);
            return;
        }

        this.#culledThisFlush.clear();
        for (const index of dirty) this.#cullOnce(index);
        for (const index of this.xf.consumeResolvedDirty(this.#resolvedOut)) {
            this.#cullOnce(index);
        }
    }

    /** {@link cull} for a node the current flush has not already decided. */
    #cullOnce(index: number): void {
        if (this.#culledThisFlush.has(index)) return;
        this.#culledThisFlush.add(index);
        this.#cull(index);
    }

    /** Recomputes one node's cull flag and pushes it to the backend. */
    #cull(index: number): void {
        const draw = this.#shouldDraw(index);
        this.xf.setCulled(index, !draw);
        // The art only: children are siblings of art, so culling a parent cannot hide them.
        this.#sink.setRenderable(index, draw);
    }

    /** Recreates every display object from our records, then marks all dirty. */
    rebuildScene(): void {
        this.#sink.clearAll();
        // Parents before children, so a child always has somewhere to attach.
        for (const root of this.xf.roots(this.#rootsOut)) {
            for (const slot of this.xf.subtree(root, this.#subtreeOut, true)) {
                const record = this.nodes.recordAt(slot);
                if (record === null) continue;
                this.#sink.create(slot, record, this.xf.parent(slot));
            }
        }
        this.xf.markAllDirty();
        this.#cullAll = true;
        this.flush();
    }

    /** `true` when `render()` last decided this node draws. */
    isCulled(id: NodeId): boolean {
        const index = this.nodes.indexOf(id);
        return index < 0 ? false : this.xf.culled(index);
    }

    /** Root ids for one surface in draw order — by `layer`, ties by insertion. */
    drawOrderOf(surface: Surface): NodeId[] {
        return this.#inDrawOrder(
            this.xf.roots().filter((slot) => this.nodes.recordAt(slot)?.surface === surface),
        );
    }

    /**
     * Slots as ids, ordered by `layer` with ties broken by their position in `slots`.
     *
     * One rule for roots and for a node's children alike: a tree view that ordered the two
     * differently would misrepresent what draws on top. A slot with no record is dropped, because
     * the sibling walk behind a child list is not itself checked for liveness.
     */
    #inDrawOrder(slots: readonly number[]): NodeId[] {
        return (
            slots
                .map((slot, insertion) => ({
                    slot,
                    insertion,
                    layer: this.nodes.recordAt(slot)?.layer ?? 0,
                }))
                // `toSorted` is stable, so equal layers keep insertion order.
                .toSorted((a, b) => a.layer - b.layer || a.insertion - b.insertion)
                .map((entry) => this.nodes.idAt(entry.slot))
                .filter((id) => id !== NO_NODE)
        );
    }

    /**
     * The scene as a plain snapshot, for tooling.
     *
     * Allocates per node deliberately: a debugger reading a live view of the SoA stores would see
     * values change under it mid-walk and could mutate the scene through a leaked reference.
     * `assets` arrives as an argument because residency is the one thing the core does not own.
     */
    inspect(
        opts: InspectOptions | undefined,
        assets: ReadonlyArray<{ name: string; size: Size }>,
        contextState: ContextState,
    ): SceneSnapshot {
        // Once up front, since re-resolving per node would be quadratic on a deep tree.
        this.xf.resolve();

        const resident = new Set(assets.map((asset) => asset.name));
        const wanted = opts?.surface;
        const skipBounds = opts?.skipBounds ?? false;

        const surfaces = this.#config.enabledSurfaces
            .filter((surface) => wanted === undefined || surface === wanted)
            .toSorted((a, b) => surfaceOrder(a) - surfaceOrder(b))
            .map((surface) => ({ surface, visible: this.#sink.surfaceVisible(surface) }));

        const roots: Partial<Record<Surface, NodeId[]>> = {};
        for (const { surface } of surfaces) roots[surface] = this.drawOrderOf(surface);

        const nodes = new Map<NodeId, NodeSnapshot>();
        let culled = 0;
        for (const slot of this.nodes.liveIndices()) {
            const record = this.nodes.recordAt(slot);
            if (record === null) continue;
            if (wanted !== undefined && record.surface !== wanted) continue;

            const id = this.nodes.idAt(slot);
            if (id === NO_NODE) continue;

            const isCulled = this.xf.culled(slot);
            if (isCulled) culled++;

            // A group has no art, so it has no extent to report.
            const hasBounds = !skipBounds && record.kind !== 'group';

            nodes.set(id, {
                id,
                kind: record.kind,
                surface: record.surface,
                layer: record.layer,
                texture: record.texture,
                text: record.text,
                uiAnchor: record.uiAnchor,
                parent: this.parentOf(id),
                children: this.#childrenInDrawOrder(slot),
                local: this.localTransformOf(id) ?? blankTransform(),
                resolved: this.resolvedTransformOf(id) ?? blankTransform(),
                localBounds: hasBounds
                    ? boundsCopy(bounds(), this.localBoundsAt(slot, this.#scratchLocal))
                    : null,
                worldBounds: hasBounds
                    ? boundsCopy(bounds(), this.worldBoundsAt(slot, this.#scratchWorld))
                    : null,
                culled: isCulled,
                // Only a sprite can miss a texture: a group has none, and text carries its string.
                missingTexture: record.kind === 'sprite' && !resident.has(record.texture),
            });
        }

        return {
            roots,
            nodes,
            surfaces,
            camera: {
                position: { ...this.#camera.position },
                zoom: this.#camera.zoom,
                framing: this.#camera.framing ?? 'stage',
            },
            canvas: { ...this.#config.canvas },
            stageRect: boundsCopy(bounds(), this.#stage),
            viewport: boundsCopy(bounds(), this.#viewport),
            resolution: this.#config.resolution,
            contextState,
            assets: assets.map((asset) => ({ name: asset.name, size: { ...asset.size } })),
            counts: {
                nodes: nodes.size,
                culled,
                surfaces: surfaces.length,
                assets: assets.length,
            },
        };
    }

    /** A node's direct children in draw order. */
    #childrenInDrawOrder(index: number): NodeId[] {
        return this.#inDrawOrder(this.xf.children(index));
    }

    /** How many live nodes reference an asset name — the `inUse` count. */
    referenceCount(name: string): number {
        let count = 0;
        for (const slot of this.nodes.liveIndices()) {
            const record = this.nodes.recordAt(slot);
            if (record === null) continue;
            if (record.texture === name) count++;
            else if (record.kind === 'text' && record.style?.font === name) count++;
        }
        return count;
    }

    /** Live slots whose sprite texture is `name`, for repointing to the placeholder. */
    slotsUsingTexture(name: string, out: number[] = []): number[] {
        out.length = 0;
        for (const slot of this.nodes.liveIndices()) {
            if (this.nodes.recordAt(slot)?.texture === name) out.push(slot);
        }
        return out;
    }

    on<K extends EventName>(event: K, handler: (e: RendererEvents[K]) => void): () => void {
        let set = this.#listeners.get(event);
        if (set === undefined) {
            set = new Set();
            this.#listeners.set(event, set);
        }
        const erased = handler as (e: never) => void;
        set.add(erased);
        return () => {
            set?.delete(erased);
        };
    }

    emit<K extends EventName>(event: K, payload: RendererEvents[K]): void {
        const set = this.#listeners.get(event);
        if (set === undefined) return;
        // Snapshotted: a handler may unsubscribe itself — or another — mid-dispatch.
        const snapshot = Array.from(set);
        for (const handler of snapshot) (handler as (e: RendererEvents[K]) => void)(payload);
    }

    /** Drops every node, listener and display object. */
    teardown(): void {
        this.#sink.clearAll();
        this.nodes.clear();
        this.xf.clear();
        this.#listeners.clear();
    }

    /** Validates a `parent` field and returns its slot index, or -1 when there is none. */
    #resolveParent(parent: NodeId | undefined, surface: Surface): number {
        if (parent === undefined || parent === NO_NODE) return NO_PARENT;
        const parentIndex = this.nodes.indexOf(parent);
        // A dead parent is a race, so it degrades to "no parent" rather than throwing.
        if (parentIndex < 0) return NO_PARENT;
        const parentRecord = this.nodes.recordAt(parentIndex);
        if (parentRecord === null) return NO_PARENT;
        if (parentRecord.surface !== surface) {
            rendererError(
                'cross-surface-parent',
                `cannot parent a '${surface}' node to a '${parentRecord.surface}' node`,
            );
        }
        return parentIndex;
    }

    /**
     * A UI node's screen position: its anchoring ancestor's origin plus its resolved design-px
     * offset, scaled by `fitScale`.
     *
     * The anchor comes from the node's surface ROOT, not from the node itself: `uiAnchor` is a
     * root-only field, a child's resolved position already includes its ancestors' offsets, and
     * taking a child's own anchor would add a second origin the backend never applies.
     */
    #uiScreenPosition(index: number, out: MutableVec3): MutableVec3 {
        return uiToScreen(
            {
                x: this.xf.resolvedX(index),
                y: this.xf.resolvedY(index),
                z: this.xf.resolvedZ(index),
            },
            this.#anchorOf(index),
            this.#stage,
            this.fitScale(),
            out,
        );
    }

    /** The `uiAnchor` of a node's surface root, defaulting to `'top-left'`. */
    #anchorOf(index: number): UiAnchor {
        let root = index;
        for (
            let parent = this.xf.parent(root);
            parent !== NO_PARENT;
            parent = this.xf.parent(root)
        ) {
            root = parent;
        }
        return this.nodes.recordAt(root)?.uiAnchor ?? 'top-left';
    }

    /** The cull decision for one slot. */
    #shouldDraw(index: number): boolean {
        const record = this.nodes.recordAt(index);
        if (record === null) return false;

        // `neverCull` covers visuals that exceed their bounds: thick stroke, glow, emitter.
        if (record.kind === 'group') return true;
        if (!isCameraTransformed(record.surface)) return true;
        if (this.xf.neverCull(index)) return true;
        // A hidden surface draws nothing anyway, so the flag stays un-culled and the state a
        // caller sees is independent of surface visibility.
        if (!this.#sink.surfaceVisible(record.surface)) return true;

        const world = this.worldBoundsAt(index, this.#scratchWorld);
        return isVisibleInViewport(world, this.#viewport, this.#config.cullMargin);
    }
}

/**
 * The snapshot for a renderer that is not live — before `init`, after `destroy`.
 *
 * So `inspect()` never returns `null` and an inspector panel mounting before init reads zero nodes
 * rather than crashing.
 */
export function emptySnapshot(contextState: ContextState): SceneSnapshot {
    return {
        roots: {},
        nodes: new Map(),
        surfaces: [],
        camera: { position: { x: 0, y: 0, z: 0 }, zoom: 1, framing: 'stage' },
        canvas: { width: 0, height: 0 },
        stageRect: bounds(),
        viewport: bounds(),
        resolution: 1,
        contextState,
        assets: [],
        counts: { nodes: 0, culled: 0, surfaces: 0, assets: 0 },
    };
}

/** A zeroed `Transform`, for the `out`-less call path. */
function blankTransform(): Transform {
    return {
        position: vec3(),
        rotation: 0,
        scale: vec3(1, 1, 1),
        alpha: 1,
        visible: true,
    };
}
