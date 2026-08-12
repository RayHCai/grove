// Pure. The authoritative transform graph: structure-of-arrays over growable typed arrays,
// indexed by slot index. The backend's tree mirrors this one, and nothing here asks it anything.
//
// Only position and visibility inherit, which is why `resolved` holds three axes and one flag
// rather than a full transform: for rotation, scale, alpha and tint, local IS resolved. Position
// composition is therefore vector addition — no matrix, no decomposition.
//
// Two distinct dirty sets, and conflating them is the easiest way to break this file:
//
//   resolve-dirty   Subtree scope: a position/visibility write or a relink changes the resolved
//                   values of that node and everything beneath it.
//   flush-dirty     Single node: whose LOCAL values must reach the backend. The backend tree
//                   composes for us, so moving a parent writes only the parent's local position,
//                   and a rotation write resolve-dirties nothing at all.
//
// `Float64Array` because composed positions accumulate and the drift matters more than the bytes.

/** Empty sentinel for the tree arrays. Not 0 — slot 0 is a perfectly good node. */
const NONE = -1;

/** Slots the arrays start with. Growth doubles from here. */
const INITIAL_CAPACITY = 64;

/** Default tint: unmodulated white. */
const WHITE = 0xffffff;

/**
 * The transform graph.
 *
 * Every method takes a slot index, not a `NodeId`: handle validation happens in `node-store.ts`.
 * An out-of-range index is treated as absent rather than throwing, so a race upstream degrades
 * to a no-op here too.
 */
export class TransformStore {
    #posX = new Float64Array(INITIAL_CAPACITY);
    #posY = new Float64Array(INITIAL_CAPACITY);
    #posZ = new Float64Array(INITIAL_CAPACITY);
    #rot = new Float64Array(INITIAL_CAPACITY);
    #scaleX = new Float64Array(INITIAL_CAPACITY);
    #scaleY = new Float64Array(INITIAL_CAPACITY);
    #scaleZ = new Float64Array(INITIAL_CAPACITY);
    #alpha = new Float64Array(INITIAL_CAPACITY);
    #anchorX = new Float64Array(INITIAL_CAPACITY);
    #anchorY = new Float64Array(INITIAL_CAPACITY);
    #tint = new Float64Array(INITIAL_CAPACITY);

    // Position and visibility are the only inherited values, so nothing else is resolved.
    #resolvedX = new Float64Array(INITIAL_CAPACITY);
    #resolvedY = new Float64Array(INITIAL_CAPACITY);
    #resolvedZ = new Float64Array(INITIAL_CAPACITY);

    #visible = new Uint8Array(INITIAL_CAPACITY);
    #resolvedVisible = new Uint8Array(INITIAL_CAPACITY);
    #neverCull = new Uint8Array(INITIAL_CAPACITY);
    #culled = new Uint8Array(INITIAL_CAPACITY);

    // Intrusive sibling lists, so hierarchy costs no per-node allocation.
    #parent = new Int32Array(INITIAL_CAPACITY).fill(NONE);
    #firstChild = new Int32Array(INITIAL_CAPACITY).fill(NONE);
    #lastChild = new Int32Array(INITIAL_CAPACITY).fill(NONE);
    #prevSibling = new Int32Array(INITIAL_CAPACITY).fill(NONE);
    #nextSibling = new Int32Array(INITIAL_CAPACITY).fill(NONE);
    #depth = new Int32Array(INITIAL_CAPACITY);

    /**
     * Roots in insertion order, with `NONE` for a slot that has left. Roots need this because they
     * have no parent to hold a child list.
     *
     * Tombstoned rather than spliced: removal happens on every link, unlink and release, and an
     * `indexOf` plus `splice` per call makes creating or destroying a node O(roots) — 20k flat
     * sprites then cost more to tear down than to draw. `#rootAt` maps a slot to its position, and
     * compaction runs once the tombstones outnumber the live entries.
     */
    #rootOrder: number[] = [];

    /** Slot -> its index in `#rootOrder`. */
    readonly #rootAt = new Map<number, number>();

    /** Tombstones currently in `#rootOrder`. */
    #rootHoles = 0;

    // Reused by the resolve walk, which runs every frame and must not allocate.
    readonly #pendingRoots: number[] = [];
    readonly #stack: number[] = [];
    readonly #depthStack: number[] = [];

    /** Nodes whose resolved position/visibility may be stale. Subtree scope. */
    readonly #resolveDirty = new Set<number>();

    /** Nodes whose LOCAL values must be pushed to the backend. Single-node scope. */
    readonly #flushDirty = new Set<number>();

    /** Nodes whose resolved values changed since the last drain. */
    readonly #resolvedChanged = new Set<number>();

    #count = 0;

    #visits = 0;

    /**
     * How many nodes the last `resolve()` composed.
     *
     * "Skips clean subtrees" is a claim about work, not output — an implementation that walks a
     * nested dirty root twice still produces the right numbers — so this counter is what makes
     * the claim checkable.
     */
    get lastResolveVisits(): number {
        return this.#visits;
    }

    /** Highest addressable slot + 1. */
    get slotCount(): number {
        return this.#count;
    }

    /**
     * Roots of the pending resolve walk — the nodes whose subtrees `resolve()` would recompose.
     *
     * Exposed because a write that propagated further than it should have is otherwise
     * unobservable: a rotation write that wrongly marked a subtree changes no resolved value, so
     * `consumeResolvedDirty` reports nothing either way.
     */
    pendingResolveRoots(out: number[] = []): number[] {
        out.length = 0;
        for (const index of this.#resolveDirty) out.push(index);
        return out;
    }

    /** Grows the arrays so `index` is addressable and resets that slot to defaults. */
    initSlot(index: number): void {
        if (index < 0 || !Number.isInteger(index)) return;
        this.#ensure(index + 1);
        if (index >= this.#count) this.#count = index + 1;
        this.#reset(index);
        this.#flushDirty.add(index);
        this.#resolveDirty.add(index);
        this.#addRoot(index);
    }

    /** Unlinks and resets the slot. Does NOT touch children — the caller cascades. */
    releaseSlot(index: number): void {
        if (!this.#has(index)) return;
        // Detached directly rather than through `unlink`, which would re-add it as a root only for
        // the next line to take it back out.
        this.#detach(index);
        this.#reset(index);
        this.#flushDirty.delete(index);
        this.#resolveDirty.delete(index);
        this.#resolvedChanged.delete(index);
        this.#removeRoot(index);
    }

    /** Drops all state. */
    clear(): void {
        for (let i = 0; i < this.#count; i++) this.#reset(i);
        this.#count = 0;
        this.#rootOrder.length = 0;
        this.#rootAt.clear();
        this.#rootHoles = 0;
        this.#resolveDirty.clear();
        this.#flushDirty.clear();
        this.#resolvedChanged.clear();
    }

    setPosition(index: number, x: number, y: number, z: number): void {
        if (!this.#has(index)) return;
        this.#posX[index] = x;
        this.#posY[index] = y;
        this.#posZ[index] = z;
        // The subtree's resolved values move with this node, but only this node's locals changed.
        this.#flushDirty.add(index);
        this.#resolveDirty.add(index);
    }

    setVisible(index: number, visible: boolean): void {
        if (!this.#has(index)) return;
        this.#visible[index] = visible ? 1 : 0;
        this.#flushDirty.add(index);
        this.#resolveDirty.add(index);
    }

    setRotation(index: number, degrees: number): void {
        if (!this.#has(index)) return;
        this.#rot[index] = degrees;
        // Rotation does not inherit, so there is nothing to re-resolve anywhere.
        this.#flushDirty.add(index);
    }

    setScale(index: number, x: number, y: number, z: number): void {
        if (!this.#has(index)) return;
        this.#scaleX[index] = x;
        this.#scaleY[index] = y;
        this.#scaleZ[index] = z;
        this.#flushDirty.add(index);
    }

    setAlpha(index: number, alpha: number): void {
        if (!this.#has(index)) return;
        this.#alpha[index] = alpha;
        this.#flushDirty.add(index);
    }

    setAnchor(index: number, x: number, y: number): void {
        if (!this.#has(index)) return;
        this.#anchorX[index] = x;
        this.#anchorY[index] = y;
        this.#flushDirty.add(index);
    }

    setTint(index: number, tint: number): void {
        if (!this.#has(index)) return;
        this.#tint[index] = tint;
        this.#flushDirty.add(index);
    }

    setNeverCull(index: number, neverCull: boolean): void {
        if (!this.#has(index)) return;
        this.#neverCull[index] = neverCull ? 1 : 0;
        this.#flushDirty.add(index);
    }

    /** Written by the flush pass, not by a caller patch, so it dirties nothing. */
    setCulled(index: number, culled: boolean): void {
        if (!this.#has(index)) return;
        this.#culled[index] = culled ? 1 : 0;
    }

    posX(index: number): number {
        return this.#has(index) ? (this.#posX[index] as number) : 0;
    }

    posY(index: number): number {
        return this.#has(index) ? (this.#posY[index] as number) : 0;
    }

    posZ(index: number): number {
        return this.#has(index) ? (this.#posZ[index] as number) : 0;
    }

    rotation(index: number): number {
        return this.#has(index) ? (this.#rot[index] as number) : 0;
    }

    scaleX(index: number): number {
        return this.#has(index) ? (this.#scaleX[index] as number) : 1;
    }

    scaleY(index: number): number {
        return this.#has(index) ? (this.#scaleY[index] as number) : 1;
    }

    scaleZ(index: number): number {
        return this.#has(index) ? (this.#scaleZ[index] as number) : 1;
    }

    alpha(index: number): number {
        return this.#has(index) ? (this.#alpha[index] as number) : 1;
    }

    anchorX(index: number): number {
        return this.#has(index) ? (this.#anchorX[index] as number) : 0.5;
    }

    anchorY(index: number): number {
        return this.#has(index) ? (this.#anchorY[index] as number) : 0.5;
    }

    tint(index: number): number {
        return this.#has(index) ? (this.#tint[index] as number) : WHITE;
    }

    visible(index: number): boolean {
        return this.#has(index) ? this.#visible[index] === 1 : false;
    }

    neverCull(index: number): boolean {
        return this.#has(index) ? this.#neverCull[index] === 1 : false;
    }

    culled(index: number): boolean {
        return this.#has(index) ? this.#culled[index] === 1 : false;
    }

    resolvedX(index: number): number {
        return this.#has(index) ? (this.#resolvedX[index] as number) : 0;
    }

    resolvedY(index: number): number {
        return this.#has(index) ? (this.#resolvedY[index] as number) : 0;
    }

    resolvedZ(index: number): number {
        return this.#has(index) ? (this.#resolvedZ[index] as number) : 0;
    }

    resolvedVisible(index: number): boolean {
        return this.#has(index) ? this.#resolvedVisible[index] === 1 : false;
    }

    parent(index: number): number {
        return this.#has(index) ? (this.#parent[index] as number) : NONE;
    }

    firstChild(index: number): number {
        return this.#has(index) ? (this.#firstChild[index] as number) : NONE;
    }

    lastChild(index: number): number {
        return this.#has(index) ? (this.#lastChild[index] as number) : NONE;
    }

    nextSibling(index: number): number {
        return this.#has(index) ? (this.#nextSibling[index] as number) : NONE;
    }

    prevSibling(index: number): number {
        return this.#has(index) ? (this.#prevSibling[index] as number) : NONE;
    }

    depth(index: number): number {
        return this.#has(index) ? (this.#depth[index] as number) : 0;
    }

    /**
     * Appends `child` as `parent`'s last child; `parent === NONE` makes it a root.
     *
     * Stable, which is what makes "within a layer, order is insertion-defined" true. Does not
     * adjust local position — reinterpret versus preserve is the caller's policy.
     */
    link(child: number, parent: number): void {
        if (!this.#has(child)) return;
        if (parent !== NONE && !this.#has(parent)) return;
        if (child === parent) return;
        // Rejected upstream as a caller bug; guarded again so a slip cannot leave an unwalkable
        // tree behind.
        if (parent !== NONE && this.isAncestorOf(child, parent)) return;

        this.#detach(child);

        if (parent === NONE) {
            this.#parent[child] = NONE;
            this.#addRoot(child);
        } else {
            this.#parent[child] = parent;
            const last = this.#lastChild[parent] as number;
            if (last === NONE) {
                this.#firstChild[parent] = child;
            } else {
                this.#nextSibling[last] = child;
                this.#prevSibling[child] = last;
            }
            this.#lastChild[parent] = child;
        }

        this.#refreshDepth(child);
        this.#flushDirty.add(child);
        this.#resolveDirty.add(child);
    }

    /** Makes `child` a root. */
    unlink(child: number): void {
        if (!this.#has(child)) return;
        if ((this.#parent[child] as number) === NONE) return;
        this.link(child, NONE);
    }

    /** `true` when `ancestor` is `node` or one of its ancestors — the cycle check. */
    isAncestorOf(ancestor: number, node: number): boolean {
        if (!this.#has(ancestor) || !this.#has(node)) return false;
        let walk = node;
        // The slot-count countdown is a backstop: a malformed cycle would otherwise spin forever.
        for (let guard = this.#count; walk !== NONE && guard >= 0; guard--) {
            if (walk === ancestor) return true;
            walk = this.#parent[walk] as number;
        }
        return false;
    }

    /** Direct children in sibling order. */
    children(index: number, out: number[] = []): number[] {
        out.length = 0;
        if (!this.#has(index)) return out;
        for (
            let c = this.#firstChild[index] as number;
            c !== NONE;
            c = this.#nextSibling[c] as number
        ) {
            out.push(c);
        }
        return out;
    }

    /**
     * `index` and every descendant, parent before child.
     *
     * Breadth-first over `out` itself: the queue head walks the array being filled, so excluding the
     * root costs one extra seeding pass rather than a second array — and never a spread, which
     * throws once a node has more direct children than the engine's argument limit.
     */
    subtree(index: number, out: number[] = [], includeRoot = true): number[] {
        out.length = 0;
        if (!this.#has(index)) return out;

        if (includeRoot) {
            out.push(index);
        } else {
            for (
                let c = this.#firstChild[index] as number;
                c !== NONE;
                c = this.#nextSibling[c] as number
            ) {
                out.push(c);
            }
        }

        for (let head = 0; head < out.length; head++) {
            const node = out[head] as number;
            for (
                let c = this.#firstChild[node] as number;
                c !== NONE;
                c = this.#nextSibling[c] as number
            ) {
                out.push(c);
            }
        }
        return out;
    }

    /** Root slot indices, in insertion order. */
    roots(out: number[] = []): number[] {
        out.length = 0;
        for (const index of this.#rootOrder) {
            if (index === NONE) continue;
            if (this.#has(index) && (this.#parent[index] as number) === NONE) out.push(index);
        }
        return out;
    }

    /**
     * Recomposes resolved position and visibility, skipping clean subtrees.
     *
     * A dirty node whose ancestor is also dirty is reached by the ancestor's walk and dropped from
     * the work list first, so no subtree is composed twice.
     */
    resolve(): void {
        this.#visits = 0;
        if (this.#resolveDirty.size === 0) return;

        // Copied into a reused buffer, because `#resolveFrom` deletes from the set it walks and this
        // runs every frame: sorting by depth would allocate two more arrays to reach the same place
        // the ancestor check below reaches for nothing.
        const pending = this.#pendingRoots;
        pending.length = 0;
        for (const index of this.#resolveDirty) pending.push(index);

        for (const index of pending) {
            if (!this.#resolveDirty.has(index)) continue;
            // An entry whose ancestor is also dirty is reached by that ancestor's walk, so skipping
            // it here is what keeps a subtree from being composed twice.
            if (this.#hasDirtyAncestor(index)) continue;
            this.#resolveFrom(index);
        }
        this.#resolveDirty.clear();
    }

    /**
     * Marks a node's local values as needing a push to the backend.
     *
     * For a change the store does not hold — a texture swap, a new string — whose SIZE still feeds
     * bounds and culling.
     */
    markFlushDirty(index: number): void {
        if (!this.#has(index)) return;
        this.#flushDirty.add(index);
    }

    /** Drains the flush-dirty set: nodes whose local values changed. */
    consumeFlushDirty(out: number[] = []): number[] {
        out.length = 0;
        for (const index of this.#flushDirty) out.push(index);
        this.#flushDirty.clear();
        return out;
    }

    /** Drains the set of nodes whose resolved values changed since the last drain. */
    consumeResolvedDirty(out: number[] = []): number[] {
        out.length = 0;
        for (const index of this.#resolvedChanged) out.push(index);
        this.#resolvedChanged.clear();
        return out;
    }

    /** Marks everything dirty, for the post-context-loss rebuild. */
    markAllDirty(): void {
        for (let i = 0; i < this.#count; i++) {
            this.#flushDirty.add(i);
            if ((this.#parent[i] as number) === NONE) this.#resolveDirty.add(i);
        }
    }

    /** `true` when `index` addresses an initialized slot. */
    #has(index: number): boolean {
        return index >= 0 && index < this.#count && Number.isInteger(index);
    }

    /** `true` when any ancestor of `index` is itself waiting to be resolved. */
    #hasDirtyAncestor(index: number): boolean {
        for (
            let walk = this.#parent[index] as number;
            walk !== NONE;
            walk = this.#parent[walk] as number
        ) {
            if (this.#resolveDirty.has(walk)) return true;
        }
        return false;
    }

    /**
     * Composes `index` and its descendants from its parent's resolved values.
     *
     * Iterative because a deep chain of parented nodes is a legitimate authoring shape and must
     * not risk the JS stack.
     */
    #resolveFrom(index: number): void {
        const stack = this.#stack;
        stack.length = 0;
        stack.push(index);
        while (stack.length > 0) {
            const node = stack.pop() as number;
            this.#resolveDirty.delete(node);
            this.#visits++;

            const parent = this.#parent[node] as number;
            const baseX = parent === NONE ? 0 : (this.#resolvedX[parent] as number);
            const baseY = parent === NONE ? 0 : (this.#resolvedY[parent] as number);
            const baseZ = parent === NONE ? 0 : (this.#resolvedZ[parent] as number);
            const baseVisible = parent === NONE ? 1 : (this.#resolvedVisible[parent] as number);

            // Addition and nothing else — no matrix, no rotation of the offset — so it is exact.
            const nx = baseX + (this.#posX[node] as number);
            const ny = baseY + (this.#posY[node] as number);
            const nz = baseZ + (this.#posZ[node] as number);
            const nv = baseVisible === 1 && this.#visible[node] === 1 ? 1 : 0;

            const changed =
                nx !== (this.#resolvedX[node] as number) ||
                ny !== (this.#resolvedY[node] as number) ||
                nz !== (this.#resolvedZ[node] as number) ||
                nv !== (this.#resolvedVisible[node] as number);

            this.#resolvedX[node] = nx;
            this.#resolvedY[node] = ny;
            this.#resolvedZ[node] = nz;
            this.#resolvedVisible[node] = nv;
            if (changed) this.#resolvedChanged.add(node);

            for (
                let c = this.#firstChild[node] as number;
                c !== NONE;
                c = this.#nextSibling[c] as number
            ) {
                stack.push(c);
            }
        }
    }

    /** Removes `child` from whatever list holds it, leaving its own links cleared. */
    #detach(child: number): void {
        const parent = this.#parent[child] as number;
        const prev = this.#prevSibling[child] as number;
        const next = this.#nextSibling[child] as number;

        if (prev !== NONE) this.#nextSibling[prev] = next;
        if (next !== NONE) this.#prevSibling[next] = prev;

        if (parent !== NONE) {
            if ((this.#firstChild[parent] as number) === child) this.#firstChild[parent] = next;
            if ((this.#lastChild[parent] as number) === child) this.#lastChild[parent] = prev;
        } else {
            this.#removeRoot(child);
        }

        this.#prevSibling[child] = NONE;
        this.#nextSibling[child] = NONE;
        this.#parent[child] = NONE;
    }

    /** Rewrites `depth` for `index` and everything under it, after a move. */
    #refreshDepth(index: number): void {
        const stack = this.#depthStack;
        stack.length = 0;
        stack.push(index);
        while (stack.length > 0) {
            const node = stack.pop() as number;
            const parent = this.#parent[node] as number;
            this.#depth[node] = parent === NONE ? 0 : (this.#depth[parent] as number) + 1;
            for (
                let c = this.#firstChild[node] as number;
                c !== NONE;
                c = this.#nextSibling[c] as number
            ) {
                stack.push(c);
            }
        }
    }

    /** Appends a slot to the root order. */
    #addRoot(index: number): void {
        if (this.#rootAt.has(index)) return;
        this.#rootAt.set(index, this.#rootOrder.length);
        this.#rootOrder.push(index);
    }

    /** Tombstones a slot's entry in the root order, compacting once the holes dominate. */
    #removeRoot(index: number): void {
        const at = this.#rootAt.get(index);
        if (at === undefined) return;
        this.#rootOrder[at] = NONE;
        this.#rootAt.delete(index);
        this.#rootHoles++;
        if (this.#rootHoles > this.#rootAt.size) this.#compactRoots();
    }

    /** Drops the tombstones, preserving insertion order. */
    #compactRoots(): void {
        const live: number[] = [];
        for (const index of this.#rootOrder) {
            if (index === NONE) continue;
            this.#rootAt.set(index, live.length);
            live.push(index);
        }
        this.#rootOrder = live;
        this.#rootHoles = 0;
    }

    /** Restores one slot to its defaults. */
    #reset(index: number): void {
        this.#posX[index] = 0;
        this.#posY[index] = 0;
        this.#posZ[index] = 0;
        this.#rot[index] = 0;
        this.#scaleX[index] = 1;
        this.#scaleY[index] = 1;
        this.#scaleZ[index] = 1;
        this.#alpha[index] = 1;
        // Centered, so the common negative-x flip pivots in place.
        this.#anchorX[index] = 0.5;
        this.#anchorY[index] = 0.5;
        this.#tint[index] = WHITE;

        this.#resolvedX[index] = 0;
        this.#resolvedY[index] = 0;
        this.#resolvedZ[index] = 0;

        this.#visible[index] = 1;
        this.#resolvedVisible[index] = 1;
        this.#neverCull[index] = 0;
        this.#culled[index] = 0;

        this.#parent[index] = NONE;
        this.#firstChild[index] = NONE;
        this.#lastChild[index] = NONE;
        this.#prevSibling[index] = NONE;
        this.#nextSibling[index] = NONE;
        this.#depth[index] = 0;
    }

    /** Grows every array to hold at least `needed` slots, preserving contents. */
    #ensure(needed: number): void {
        if (needed <= this.#posX.length) return;

        let capacity = this.#posX.length;
        while (capacity < needed) capacity *= 2;

        this.#posX = growF64(this.#posX, capacity);
        this.#posY = growF64(this.#posY, capacity);
        this.#posZ = growF64(this.#posZ, capacity);
        this.#rot = growF64(this.#rot, capacity);
        this.#scaleX = growF64(this.#scaleX, capacity);
        this.#scaleY = growF64(this.#scaleY, capacity);
        this.#scaleZ = growF64(this.#scaleZ, capacity);
        this.#alpha = growF64(this.#alpha, capacity);
        this.#anchorX = growF64(this.#anchorX, capacity);
        this.#anchorY = growF64(this.#anchorY, capacity);
        this.#tint = growF64(this.#tint, capacity);

        this.#resolvedX = growF64(this.#resolvedX, capacity);
        this.#resolvedY = growF64(this.#resolvedY, capacity);
        this.#resolvedZ = growF64(this.#resolvedZ, capacity);

        this.#visible = growU8(this.#visible, capacity);
        this.#resolvedVisible = growU8(this.#resolvedVisible, capacity);
        this.#neverCull = growU8(this.#neverCull, capacity);
        this.#culled = growU8(this.#culled, capacity);

        // New tree slots must read NONE, not 0 — 0 is a valid node.
        this.#parent = growI32(this.#parent, capacity, NONE);
        this.#firstChild = growI32(this.#firstChild, capacity, NONE);
        this.#lastChild = growI32(this.#lastChild, capacity, NONE);
        this.#prevSibling = growI32(this.#prevSibling, capacity, NONE);
        this.#nextSibling = growI32(this.#nextSibling, capacity, NONE);
        this.#depth = growI32(this.#depth, capacity, 0);
    }
}

// The `<ArrayBuffer>` argument is load-bearing: the unparameterized spelling widens to
// `ArrayBufferLike`, which includes `SharedArrayBuffer` and is not assignable back to the fields.

function growF64(src: Float64Array<ArrayBuffer>, capacity: number): Float64Array<ArrayBuffer> {
    const next = new Float64Array(capacity);
    next.set(src);
    return next;
}

function growU8(src: Uint8Array<ArrayBuffer>, capacity: number): Uint8Array<ArrayBuffer> {
    const next = new Uint8Array(capacity);
    next.set(src);
    return next;
}

function growI32(
    src: Int32Array<ArrayBuffer>,
    capacity: number,
    fill: number,
): Int32Array<ArrayBuffer> {
    const next = new Int32Array(capacity);
    // Only the new tail needs the sentinel; `set` overwrites the rest.
    if (fill !== 0) next.fill(fill, src.length);
    next.set(src);
    return next;
}
