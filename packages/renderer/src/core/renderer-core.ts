// Everything both backends share, in ONE copy.
//
// This exists because the two backends were duplicating it: 15 methods byte-identical and a dozen
// more at 72-98% similarity, including the whole of `createNode`'s validation — and the contract
// suite only ran against one of them, so a divergence would have gone unnoticed. It already had:
// the headless cull path ignored surface visibility while the Pixi one skipped hidden surfaces, so
// the same scene could report different `culled` state per backend.
//
// WHAT LIVES HERE: the two stores, handle validation, the validation ORDER the contract asserts,
// hierarchy with the attach/detach asymmetry (§11.1), the resolve/flush/cull pass, projection and
// bounds, asset bookkeeping that is not GPU-specific, and the event emitter.
//
// WHAT DOES NOT: anything touching a display object or a GPU resource. That goes through
// `SceneSink`, and a backend is the only place a Pixi type may appear.

import type { Bounds, MutableVec3, Size, Vec3Like } from '@platform/math';
import { bounds, boundsCopy, boundsSet, vec3, vec3Set } from '@platform/math';
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
    Surface,
    Transform,
    UiAnchor,
} from '../renderer.js';
import type { NodeId } from '../node-id.js';
import { NO_NODE } from '../node-id.js';
import { rendererError } from '../errors.js';
import { DEFAULT_SURFACES, isCameraTransformed, surfaceOrder } from '../surfaces.js';
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
export interface CoreConfig {
    design: Size;
    canvas: Size;
    scaleMode: ScaleMode;
    letterbox: boolean;
    cullMargin: number;
    resolution: number;
    enabledSurfaces: Surface[];
}

/**
 * Validates raw init options and applies every default.
 *
 * Shared so both backends reject the same inputs with the same codes — the contract suite asserts
 * that, and it is the kind of thing that silently drifts when duplicated.
 */
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

    return {
        design: { width: options.design.width, height: options.design.height },
        canvas: { width: canvas.width, height: canvas.height },
        scaleMode: options.scaleMode ?? 'fit',
        letterbox: options.letterbox ?? true,
        cullMargin: options.cullMargin ?? DEFAULT_CULL_MARGIN,
        resolution,
        enabledSurfaces: [...(options.enabledSurfaces ?? DEFAULT_SURFACES)],
    };
}

/**
 * The backend-independent renderer.
 *
 * A backend owns one of these plus a {@link SceneSink}, and forwards its `IRenderer` methods here.
 */
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
    readonly #subtreeOut: number[] = [];

    constructor(sink: SceneSink, config: CoreConfig) {
        this.#sink = sink;
        this.#config = config;
        this.recomputeRects();
    }

    // ─── config ─────────────────────────────────────────────────────

    get config(): Readonly<CoreConfig> {
        return this.#config;
    }

    get canvasSize(): Readonly<Size> {
        return this.#config.canvas;
    }

    get resolution(): number {
        return this.#config.resolution;
    }

    get stageRect(): Readonly<Bounds> {
        return this.#stage;
    }

    get viewport(): Bounds {
        return this.#viewport;
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
        // Copied, not retained: a caller may reuse one camera object every frame. The renderer
        // NEVER clamps a camera — `camera.bounds` is engine-enforced (§4.1).
        this.#camera = {
            position: {
                x: camera.position.x,
                y: camera.position.y,
                z: camera.position.z ?? 0,
            },
            zoom: camera.zoom,
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

    // ─── nodes ──────────────────────────────────────────────────────

    /**
     * Validates and allocates a node.
     *
     * VALIDATION ORDER IS PART OF THE CONTRACT — surface enabled, then text-on-camera-surface,
     * then empty texture, then the parent checks. The suite asserts each throw, and a backend
     * reordering them would change which error a caller sees.
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
                    `create a sprite node with that texture (§9.3)`,
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

        if (desc.position !== undefined) {
            this.xf.setPosition(index, desc.position.x, desc.position.y, desc.position.z ?? 0);
        }
        if (desc.visible !== undefined) this.xf.setVisible(index, desc.visible);
        if (desc.rotation !== undefined) this.xf.setRotation(index, desc.rotation);
        if (desc.scale !== undefined) {
            this.xf.setScale(index, desc.scale.x, desc.scale.y, desc.scale.z ?? 1);
        }
        if (desc.alpha !== undefined) this.xf.setAlpha(index, desc.alpha);
        if (desc.anchor !== undefined) this.xf.setAnchor(index, desc.anchor.x, desc.anchor.y);
        if (desc.tint !== undefined) this.xf.setTint(index, desc.tint);
        if (desc.neverCull !== undefined) this.xf.setNeverCull(index, desc.neverCull);
        if (parentIndex >= 0) this.xf.link(index, parentIndex);

        this.#sink.create(index, record, parentIndex);
        return id;
    }

    destroyNode(id: NodeId): void {
        const index = this.nodes.indexOf(id);
        // A stale handle is a legitimate race — `entity.destroy()` mid-frame — so it is a no-op,
        // not a throw (§7).
        if (index < 0) return;

        // Cascades, matching `Entity.destroy()` (api_spec.ts:256).
        const subtree = this.xf.subtree(index, [], true);
        const descendants = subtree.slice(1);
        this.#sink.destroySubtree(index, descendants);

        // Deepest first, so a released slot is never a live node's parent.
        for (let i = subtree.length - 1; i >= 0; i--) {
            const slot = subtree[i] as number;
            this.xf.releaseSlot(slot);
            this.nodes.release(slot);
        }
    }

    updateNodes(patches: readonly NodePatch[]): void {
        // Retains nothing past the call — not the array, not any patch object (§11.1).
        for (const patch of patches) {
            const index = this.nodes.indexOf(patch.id);
            if (index < 0) continue;
            const record = this.nodes.recordAt(index);
            if (record === null) continue;

            if (patch.parent !== undefined) {
                if (patch.parent === NO_NODE) this.detachAt(index, true);
                else this.attachAt(index, patch.parent, false);
            }
            if (patch.position !== undefined) {
                this.xf.setPosition(
                    index,
                    patch.position.x,
                    patch.position.y,
                    patch.position.z ?? 0,
                );
            }
            if (patch.rotation !== undefined) this.xf.setRotation(index, patch.rotation);
            if (patch.scale !== undefined) {
                this.xf.setScale(index, patch.scale.x, patch.scale.y, patch.scale.z ?? 1);
            }
            if (patch.anchor !== undefined)
                this.xf.setAnchor(index, patch.anchor.x, patch.anchor.y);
            if (patch.alpha !== undefined) this.xf.setAlpha(index, patch.alpha);
            if (patch.visible !== undefined) this.xf.setVisible(index, patch.visible);
            if (patch.tint !== undefined) this.xf.setTint(index, patch.tint);
            if (patch.layer !== undefined) {
                record.layer = patch.layer;
                this.#sink.setLayer(index, patch.layer);
            }
            // A `texture` on a non-sprite and a `text` on a non-UI-text node are IGNORED:
            // wrong-shaped patches come from generic client code, not from a caller bug worth
            // throwing over (§11.1).
            if (patch.texture !== undefined && record.kind === 'sprite') {
                record.texture = patch.texture;
                this.#sink.setTexture(index, record);
            }
            if (patch.text !== undefined && record.kind === 'text') {
                record.text = patch.text;
                this.#sink.setText(index, patch.text);
            }
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
        // SET-ONLY, establishing no inheritance: a node attached later is unaffected (§5.1). The
        // honest cost is that `{alpha: 0.5}` FLATTENS a subtree that had varied alphas.
        for (const slot of this.xf.subtree(index, this.#subtreeOut, includeRoot)) {
            const id = this.nodes.idAt(slot);
            if (id === NO_NODE) continue;
            this.updateNodes([{ ...patch, id }]);
        }
    }

    setNodeText(id: NodeId, text: string): void {
        const index = this.nodes.indexOf(id);
        if (index < 0) return;
        const record = this.nodes.recordAt(index);
        // UI-only: world text is an asset, so changing it means a new text asset and a texture
        // swap (§9.3).
        if (record === null || record.kind !== 'text') return;
        record.text = text;
        this.#sink.setText(index, text);
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

    // ─── hierarchy ──────────────────────────────────────────────────

    /**
     * `attachNode`, handle lookup and default included.
     *
     * `keepResolvedPosition` defaults to FALSE here and TRUE in {@link detachNode} — asymmetric on
     * purpose, matching api_spec.ts:211-212 where `attachTo` says "position becomes local to
     * parent" and `detach` says "keeps world position". Matching the creator API is worth more
     * than internal symmetry (§11.1), and the pair lives here so neither backend can drift on it.
     */
    attachNode(child: NodeId, parent: NodeId, opts?: { keepResolvedPosition?: boolean }): void {
        const index = this.nodes.indexOf(child);
        // A stale handle is a race, so it is a no-op (§7).
        if (index < 0) return;
        this.attachAt(index, parent, opts?.keepResolvedPosition ?? false);
    }

    /** `detachNode`, defaulting `keepResolvedPosition` to TRUE — "keeps world position". */
    detachNode(child: NodeId, opts?: { keepResolvedPosition?: boolean }): void {
        const index = this.nodes.indexOf(child);
        if (index < 0) return;
        this.detachAt(index, opts?.keepResolvedPosition ?? true);
    }

    /**
     * Creates a batch. No intra-batch parenting — a `parent` must already exist (§11.1).
     */
    createNodes(descs: readonly NodeDesc[], out: NodeId[] = []): NodeId[] {
        out.length = 0;
        for (const desc of descs) out.push(this.createNode(desc));
        return out;
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

        if (keepResolvedPosition) {
            this.xf.resolve();
            const wantX = this.xf.resolvedX(index);
            const wantY = this.xf.resolvedY(index);
            const wantZ = this.xf.resolvedZ(index);
            this.xf.link(index, parentIndex);
            this.xf.resolve();
            // Only position inherits, so preserving a resolved position is plain subtraction of
            // the new parent's resolved position — no matrix anywhere (§5).
            this.xf.setPosition(
                index,
                wantX - this.xf.resolvedX(parentIndex),
                wantY - this.xf.resolvedY(parentIndex),
                wantZ - this.xf.resolvedZ(parentIndex),
            );
        } else {
            this.xf.link(index, parentIndex);
        }

        this.#sink.reparent(index, childRecord, parentIndex);
    }

    detachAt(index: number, keepResolvedPosition: boolean): void {
        if (this.xf.parent(index) === NO_PARENT) return;
        if (keepResolvedPosition) {
            this.xf.resolve();
            const wantX = this.xf.resolvedX(index);
            const wantY = this.xf.resolvedY(index);
            const wantZ = this.xf.resolvedZ(index);
            this.xf.unlink(index);
            this.xf.setPosition(index, wantX, wantY, wantZ);
        } else {
            this.xf.unlink(index);
        }

        const record = this.nodes.recordAt(index);
        if (record !== null) this.#sink.reparent(index, record, NO_PARENT);
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

    // ─── transforms & bounds ────────────────────────────────────────

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
        // Our store answers, never the backend (§6).
        this.xf.resolve();
        const t = out ?? blankTransform();
        vec3Set(
            t.position,
            this.xf.resolvedX(index),
            this.xf.resolvedY(index),
            this.xf.resolvedZ(index),
        );
        // Rotation, scale and alpha are LOCAL here — for those, local IS resolved (§6.1).
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
            const origin = this.#uiScreenPosition(index, record.uiAnchor, vec3());
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
            return this.#uiScreenPosition(index, record.uiAnchor, out);
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
        // Groups have zero extent, so they are never culled (§8).
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
            // The node's OWN rotation: rotation does not inherit, so no ancestor walk (§8).
            this.xf.rotation(index),
            this.xf.resolvedX(index),
            this.xf.resolvedY(index),
            out,
        );
    }

    // ─── the frame ──────────────────────────────────────────────────

    /**
     * Resolves the store, pushes dirtied local values, then recomputes cull flags.
     *
     * Called by a backend's `render()`. Draws nothing itself — a backend presents afterwards.
     */
    flush(): void {
        this.xf.resolve();

        for (const index of this.xf.consumeFlushDirty(this.#dirtyOut)) {
            const record = this.nodes.recordAt(index);
            if (record === null) continue;
            this.#sink.write(index, record);
        }

        for (const index of this.nodes.liveIndices()) {
            const draw = this.#shouldDraw(index);
            this.xf.setCulled(index, !draw);
            // Toggles the ART only. Children are siblings of art, so culling a parent cannot
            // hide them (§8).
            this.#sink.setRenderable(index, draw);
        }
    }

    /** Recreates every display object from our records, then marks all dirty (§10). */
    rebuildScene(): void {
        this.#sink.clearAll();
        // Parents before children, so a child always has somewhere to attach.
        for (const root of this.xf.roots()) {
            for (const slot of this.xf.subtree(root, [], true)) {
                const record = this.nodes.recordAt(slot);
                if (record === null) continue;
                this.#sink.create(slot, record, this.xf.parent(slot));
            }
        }
        this.xf.markAllDirty();
        this.flush();
    }

    /** `true` when `render()` last decided this node draws. */
    isCulled(id: NodeId): boolean {
        const index = this.nodes.indexOf(id);
        return index < 0 ? false : this.xf.culled(index);
    }

    // ─── inspection ─────────────────────────────────────────────────

    /**
     * Root ids for one surface in DRAW ORDER — by `layer`, ties by insertion (§11.1).
     *
     * Lives here rather than on a backend because both need it and it is pure store reading. It
     * was duplicated as a test-only member on the headless backend before `inspect` existed.
     */
    drawOrderOf(surface: Surface): NodeId[] {
        return (
            this.xf
                .roots()
                .filter((slot) => this.nodes.recordAt(slot)?.surface === surface)
                .map((slot, insertion) => ({
                    slot,
                    insertion,
                    layer: this.nodes.recordAt(slot)?.layer ?? 0,
                }))
                // `toSorted` is stable, so equal layers keep insertion order.
                .toSorted((a, b) => a.layer - b.layer || a.insertion - b.insertion)
                .map((entry) => this.nodes.idAt(entry.slot))
        );
    }

    /**
     * The scene as a plain snapshot, for tooling (§11.2).
     *
     * ALLOCATES per node, deliberately: a debugger reading a live view of our SoA stores would see
     * values change under it mid-walk and could mutate the scene through a leaked reference. Every
     * field here is a copy.
     *
     * `assets` is supplied by the backend because asset residency is the one thing the core does
     * not own — which is also why `missingTexture` takes a predicate rather than reading a map.
     */
    inspect(
        opts: InspectOptions | undefined,
        assets: ReadonlyArray<{ name: string; size: Size }>,
        contextState: ContextState,
    ): SceneSnapshot {
        // Resolve once up front: every node's `resolved` transform and world bounds depend on it,
        // and re-resolving per node would be quadratic on a deep tree.
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

            // A group has no art, so it has no extent to report (§8).
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
                // Only a sprite can miss a texture: group has none, and text carries its string.
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

    /**
     * A node's direct children in draw order.
     *
     * Sibling order is `layer` then insertion, matching {@link drawOrderOf} for roots — a tree view
     * that ordered roots one way and children another would misrepresent what draws on top.
     */
    #childrenInDrawOrder(index: number): NodeId[] {
        return this.xf
            .children(index)
            .map((slot, insertion) => ({
                slot,
                insertion,
                layer: this.nodes.recordAt(slot)?.layer ?? 0,
            }))
            .toSorted((a, b) => a.layer - b.layer || a.insertion - b.insertion)
            .map((entry) => this.nodes.idAt(entry.slot))
            .filter((id) => id !== NO_NODE);
    }

    /** How many live nodes reference an asset name — the `inUse` count of §9.2. */
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

    /** Live slots whose sprite texture is `name` — used to repoint to the placeholder (§9.2). */
    slotsUsingTexture(name: string, out: number[] = []): number[] {
        out.length = 0;
        for (const slot of this.nodes.liveIndices()) {
            if (this.nodes.recordAt(slot)?.texture === name) out.push(slot);
        }
        return out;
    }

    // ─── events ─────────────────────────────────────────────────────

    on<K extends EventName>(event: K, handler: (e: RendererEvents[K]) => void): () => void {
        let set = this.#listeners.get(event);
        if (set === undefined) {
            set = new Set();
            this.#listeners.set(event, set);
        }
        const erased = handler as (e: never) => void;
        set.add(erased);
        // Returns the unsubscribe function, matching api_spec.ts:264.
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

    // ─── internals ──────────────────────────────────────────────────

    /** Validates a `parent` field and returns its slot index, or -1 when there is none. */
    #resolveParent(parent: NodeId | undefined, surface: Surface): number {
        if (parent === undefined || parent === NO_NODE) return NO_PARENT;
        const parentIndex = this.nodes.indexOf(parent);
        // A dead parent is a race, so it degrades to "no parent" rather than throwing (§7).
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

    #uiScreenPosition(index: number, anchor: UiAnchor | undefined, out: MutableVec3): MutableVec3 {
        return uiToScreen(
            {
                x: this.xf.resolvedX(index),
                y: this.xf.resolvedY(index),
                z: this.xf.resolvedZ(index),
            },
            anchor ?? 'top-left',
            this.#stage,
            this.fitScale(),
            out,
        );
    }

    /** The §8 cull decision for one slot. */
    #shouldDraw(index: number): boolean {
        const record = this.nodes.recordAt(index);
        if (record === null) return false;

        // Groups have no art, UI is never culled, and `neverCull` covers visuals that exceed
        // their bounds — thick stroke, glow, emitter (§8).
        if (record.kind === 'group') return true;
        if (!isCameraTransformed(record.surface)) return true;
        if (this.xf.neverCull(index)) return true;
        // A hidden surface draws nothing anyway, so skip the arithmetic and leave the flag
        // un-culled — the state a caller sees is then independent of surface visibility.
        if (!this.#sink.surfaceVisible(record.surface)) return true;

        const world = this.worldBoundsAt(index, this.#scratchWorld);
        return isVisibleInViewport(world, this.#viewport, this.#config.cullMargin);
    }
}

/**
 * The snapshot for a renderer that is not live — before `init`, after `destroy`.
 *
 * Shared by both backends so `inspect()` never returns `null` and a consumer needs no guard: an
 * inspector panel mounting before init reads zero nodes rather than crashing.
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
