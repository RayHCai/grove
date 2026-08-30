// The transform graph: position-only inheritance, the two dirty scopes, and tree integrity
// This is the highest-risk logic in the package.
//
// The assertions below check SET CONTENTS, not just sizes — a dirty-scope bug that widened a
// single-node write into a subtree write would keep the size right for a leaf and be invisible
// to a size-only check.

import { describe, it, expect } from 'vitest';
import { TransformStore } from '../src/transform-store.js';

/** A store with `n` initialized slots, 0..n-1, all roots. */
function storeOf(n: number): TransformStore {
    const store = new TransformStore();
    for (let i = 0; i < n; i++) store.initSlot(i);
    return store;
}

/** Drains both dirty sets so a test can assert on what a single write produces. */
function settle(store: TransformStore): void {
    store.resolve();
    store.consumeFlushDirty();
    store.consumeResolvedDirty();
}

/** Sorted, so a comparison does not depend on Set iteration order. */
function sorted(values: number[]): number[] {
    return values.toSorted((a, b) => a - b);
}

describe('defaults', () => {
    it('initializes a slot to the documented defaults', () => {
        const store = storeOf(1);
        expect(store.posX(0)).toBe(0);
        expect(store.posY(0)).toBe(0);
        expect(store.posZ(0)).toBe(0);
        expect(store.rotation(0)).toBe(0);
        expect(store.scaleX(0)).toBe(1);
        expect(store.scaleY(0)).toBe(1);
        expect(store.scaleZ(0)).toBe(1);
        expect(store.alpha(0)).toBe(1);
        expect(store.tint(0)).toBe(0xffffff);
        expect(store.visible(0)).toBe(true);
        expect(store.neverCull(0)).toBe(false);
        expect(store.culled(0)).toBe(false);
        expect(store.depth(0)).toBe(0);
        expect(store.parent(0)).toBe(-1);
    });

    it('centers the anchor — a negative-x flip must pivot in place', () => {
        const store = storeOf(1);
        expect(store.anchorX(0)).toBe(0.5);
        expect(store.anchorY(0)).toBe(0.5);
    });

    it('uses -1, not 0, as the empty tree sentinel — slot 0 is a valid node', () => {
        const store = storeOf(2);
        store.link(1, 0);
        expect(store.parent(1)).toBe(0);
        expect(store.firstChild(0)).toBe(1);
        // Slot 0 is a root and a leaf-less parent's child links must read -1, never 0.
        expect(store.parent(0)).toBe(-1);
        expect(store.firstChild(1)).toBe(-1);
    });
});

describe('position-only inheritance', () => {
    it('adds a parent position into a child', () => {
        const store = storeOf(2);
        store.setPosition(0, 10, 20, 3);
        store.setPosition(1, 5, -4, 1);
        store.link(1, 0);
        store.resolve();

        expect(store.resolvedX(1)).toBe(15);
        expect(store.resolvedY(1)).toBe(16);
        expect(store.resolvedZ(1)).toBe(4);
    });

    it('does NOT inherit rotation, scale, alpha or tint — local IS resolved for those', () => {
        const store = storeOf(2);
        store.link(1, 0);
        store.setRotation(0, 90);
        store.setScale(0, 3, 3, 3);
        store.setAlpha(0, 0.25);
        store.setTint(0, 0xff0000);
        store.resolve();

        // The child keeps its own defaults with a fully-transformed parent above it.
        expect(store.rotation(1)).toBe(0);
        expect(store.scaleX(1)).toBe(1);
        expect(store.scaleY(1)).toBe(1);
        expect(store.alpha(1)).toBe(1);
        expect(store.tint(1)).toBe(0xffffff);
    });

    it('composes exactly over a 4-level chain, and after moving an intermediate node', () => {
        const store = storeOf(4);
        store.link(1, 0);
        store.link(2, 1);
        store.link(3, 2);
        store.setPosition(0, 100, 0, 0);
        store.setPosition(1, 10, 5, 0);
        store.setPosition(2, 1, 2, 0);
        store.setPosition(3, 0.5, 0.25, 0);
        store.resolve();
        expect(store.resolvedX(3)).toBe(111.5);
        expect(store.resolvedY(3)).toBe(7.25);

        // Moving node 1 must carry 2 and 3 with it.
        store.setPosition(1, 20, 5, 0);
        store.resolve();
        expect(store.resolvedX(3)).toBe(121.5);
        expect(store.resolvedY(3)).toBe(7.25);
    });

    it('leaves a root resolved equal to its local position', () => {
        const store = storeOf(1);
        store.setPosition(0, -7, 9, 2);
        store.resolve();
        expect(store.resolvedX(0)).toBe(-7);
        expect(store.resolvedY(0)).toBe(9);
        expect(store.resolvedZ(0)).toBe(2);
    });
});

describe('visibility inheritance', () => {
    it('hides a 3-deep chain from the top, and restores it', () => {
        const store = storeOf(3);
        store.link(1, 0);
        store.link(2, 1);
        store.resolve();
        expect(store.resolvedVisible(2)).toBe(true);

        store.setVisible(0, false);
        store.resolve();
        expect(store.resolvedVisible(0)).toBe(false);
        expect(store.resolvedVisible(1)).toBe(false);
        expect(store.resolvedVisible(2)).toBe(false);
        // The LOCAL flag is untouched — only the resolved value inherited.
        expect(store.visible(2)).toBe(true);

        store.setVisible(0, true);
        store.resolve();
        expect(store.resolvedVisible(2)).toBe(true);
    });

    it('keeps a descendant hidden by its own flag when the ancestor is shown', () => {
        const store = storeOf(3);
        store.link(1, 0);
        store.link(2, 1);
        store.setVisible(1, false);
        store.setVisible(0, false);
        store.resolve();
        store.setVisible(0, true);
        store.resolve();

        expect(store.resolvedVisible(0)).toBe(true);
        expect(store.resolvedVisible(1)).toBe(false);
        expect(store.resolvedVisible(2)).toBe(false);
    });
});

describe('dirty scope — a write dirties exactly what it changed', () => {
    it('flush-dirties ONE node and resolve-dirties NOTHING for a rotation write', () => {
        const store = storeOf(3);
        store.link(1, 0);
        store.link(2, 1);
        settle(store);

        store.setRotation(0, 45);
        // Nothing to recompose: rotation stops at the node that declares it. Asserted on the
        // PENDING set, because a rotation write changes no resolved value either way — so
        // `consumeResolvedDirty` alone cannot tell correct from over-propagating.
        expect(sorted(store.pendingResolveRoots())).toEqual([]);
        store.resolve();
        expect(sorted(store.consumeResolvedDirty())).toEqual([]);
        expect(sorted(store.consumeFlushDirty())).toEqual([0]);
    });

    it('resolve-dirties nothing for any other non-inheriting channel', () => {
        const store = storeOf(3);
        store.link(1, 0);
        store.link(2, 1);

        for (const write of [
            () => store.setScale(0, 2, 2, 2),
            () => store.setAlpha(0, 0.5),
            () => store.setTint(0, 0x00ff00),
            () => store.setAnchor(0, 0, 0),
            () => store.setNeverCull(0, true),
        ]) {
            settle(store);
            write();
            expect(sorted(store.pendingResolveRoots())).toEqual([]);
            expect(sorted(store.consumeFlushDirty())).toEqual([0]);
        }
    });

    it('flush-dirties one node per spinning enemy — 200 nodes, not 200 subtrees', () => {
        const store = storeOf(200);
        for (let i = 1; i < 200; i++) store.link(i, 0);
        settle(store);

        for (let i = 0; i < 200; i++) store.setRotation(i, i);
        store.resolve();
        expect(store.consumeResolvedDirty()).toEqual([]);
        expect(store.consumeFlushDirty()).toHaveLength(200);
    });

    it('resolve-dirties the SUBTREE but flush-dirties ONE node for a position write', () => {
        const store = storeOf(4);
        store.link(1, 0);
        store.link(2, 1);
        store.link(3, 0);
        settle(store);

        store.setPosition(0, 5, 5, 0);
        // Only node 0's local values changed; the backend composes the rest.
        expect(sorted(store.consumeFlushDirty())).toEqual([0]);
        store.resolve();
        // Every descendant's RESOLVED position moved.
        expect(sorted(store.consumeResolvedDirty())).toEqual([0, 1, 2, 3]);
    });

    it('reports only genuinely changed nodes as resolved-dirty', () => {
        const store = storeOf(2);
        store.link(1, 0);
        settle(store);

        // A write that does not change the value must not report a change.
        store.setPosition(0, 0, 0, 0);
        store.resolve();
        expect(store.consumeResolvedDirty()).toEqual([]);
    });

    it('does the same for a visibility write', () => {
        const store = storeOf(3);
        store.link(1, 0);
        store.link(2, 1);
        settle(store);

        store.setVisible(0, false);
        expect(sorted(store.consumeFlushDirty())).toEqual([0]);
        store.resolve();
        expect(sorted(store.consumeResolvedDirty())).toEqual([0, 1, 2]);
    });

    it('drains each dirty set exactly once', () => {
        const store = storeOf(1);
        store.setAlpha(0, 0.5);
        expect(sorted(store.consumeFlushDirty())).toEqual([0]);
        expect(store.consumeFlushDirty()).toEqual([]);
    });

    it('does not flush-dirty on a cull write — the flush pass owns that flag', () => {
        const store = storeOf(1);
        settle(store);
        store.setCulled(0, true);
        expect(store.consumeFlushDirty()).toEqual([]);
        expect(store.culled(0)).toBe(true);
    });

    it('markAllDirty then resolve recomposes the whole graph', () => {
        const store = storeOf(3);
        store.link(1, 0);
        store.link(2, 1);
        store.setPosition(0, 4, 0, 0);
        settle(store);

        store.markAllDirty();
        expect(sorted(store.consumeFlushDirty())).toEqual([0, 1, 2]);
        store.resolve();
        // Values are unchanged, so nothing is reported as CHANGED — but the walk still ran,
        // which is what the rebuild needs.
        expect(store.resolvedX(2)).toBe(4);
    });
});

describe('resolve ordering', () => {
    it('resolves a parent before its child', () => {
        const store = storeOf(3);
        // Deliberately link so that slot order and tree order disagree: 2 -> 1 -> 0 means the
        // deepest node has the lowest-numbered... no: parent 2, child 1, grandchild 0.
        store.link(1, 2);
        store.link(0, 1);
        store.setPosition(2, 100, 0, 0);
        store.setPosition(1, 10, 0, 0);
        store.setPosition(0, 1, 0, 0);
        store.resolve();

        // Only correct if 2 was composed before 1 and 1 before 0.
        expect(store.resolvedX(0)).toBe(111);
    });

    it('composes each node once when an ancestor and a descendant are both dirty', () => {
        const store = storeOf(3);
        store.link(1, 0);
        store.link(2, 1);
        settle(store);

        store.setPosition(0, 10, 0, 0);
        store.setPosition(2, 1, 0, 0);
        store.resolve();

        expect(store.resolvedX(0)).toBe(10);
        expect(store.resolvedX(1)).toBe(10);
        expect(store.resolvedX(2)).toBe(11);
        // Each node appears at most once in the changed set.
        const changed = store.consumeResolvedDirty();
        expect(changed).toHaveLength(new Set(changed).size);
        // And each was composed exactly once. Values alone cannot show this — recomposing
        // node 2 a second time yields the same number — so the work itself is asserted.
        expect(store.lastResolveVisits).toBe(3);
    });

    it('skips clean subtrees rather than walking the whole graph', () => {
        const store = storeOf(7);
        // Two independent 3-node branches under separate roots, plus one lone root.
        store.link(1, 0);
        store.link(2, 1);
        store.link(4, 3);
        store.link(5, 4);
        settle(store);

        // Dirty ONE branch. Only its three nodes may be composed.
        store.setPosition(0, 1, 0, 0);
        store.resolve();
        expect(store.lastResolveVisits).toBe(3);

        // A leaf write composes just the leaf.
        store.setPosition(5, 1, 0, 0);
        store.resolve();
        expect(store.lastResolveVisits).toBe(1);

        // Nothing dirty means no work at all.
        store.resolve();
        expect(store.lastResolveVisits).toBe(0);
    });

    it('is a no-op when nothing is resolve-dirty', () => {
        const store = storeOf(2);
        store.link(1, 0);
        settle(store);
        store.resolve();
        expect(store.consumeResolvedDirty()).toEqual([]);
    });

    it('handles a deep chain without recursing', () => {
        const depth = 5000;
        const store = storeOf(depth);
        for (let i = 1; i < depth; i++) store.link(i, i - 1);
        for (let i = 0; i < depth; i++) store.setPosition(i, 1, 0, 0);
        store.resolve();
        expect(store.resolvedX(depth - 1)).toBe(depth);
        expect(store.depth(depth - 1)).toBe(depth - 1);
    });
});

describe('tree integrity', () => {
    it('appends children in insertion order and keeps the sibling list consistent', () => {
        const store = storeOf(4);
        store.link(1, 0);
        store.link(2, 0);
        store.link(3, 0);

        expect(store.children(0)).toEqual([1, 2, 3]);
        expect(store.firstChild(0)).toBe(1);
        expect(store.lastChild(0)).toBe(3);
        expect(store.prevSibling(1)).toBe(-1);
        expect(store.nextSibling(1)).toBe(2);
        expect(store.prevSibling(3)).toBe(2);
        expect(store.nextSibling(3)).toBe(-1);
    });

    it('repairs the list when the FIRST child is unlinked', () => {
        const store = storeOf(4);
        store.link(1, 0);
        store.link(2, 0);
        store.link(3, 0);
        store.unlink(1);

        expect(store.children(0)).toEqual([2, 3]);
        expect(store.firstChild(0)).toBe(2);
        expect(store.prevSibling(2)).toBe(-1);
        expect(store.parent(1)).toBe(-1);
    });

    it('repairs the list when the LAST child is unlinked', () => {
        const store = storeOf(4);
        store.link(1, 0);
        store.link(2, 0);
        store.link(3, 0);
        store.unlink(3);

        expect(store.children(0)).toEqual([1, 2]);
        expect(store.lastChild(0)).toBe(2);
        expect(store.nextSibling(2)).toBe(-1);
    });

    it('repairs the list when a MIDDLE child is unlinked', () => {
        const store = storeOf(4);
        store.link(1, 0);
        store.link(2, 0);
        store.link(3, 0);
        store.unlink(2);

        expect(store.children(0)).toEqual([1, 3]);
        expect(store.nextSibling(1)).toBe(3);
        expect(store.prevSibling(3)).toBe(1);
    });

    it('empties both ends when the only child is unlinked', () => {
        const store = storeOf(2);
        store.link(1, 0);
        store.unlink(1);
        expect(store.children(0)).toEqual([]);
        expect(store.firstChild(0)).toBe(-1);
        expect(store.lastChild(0)).toBe(-1);
    });

    it('does not duplicate a child when relinked to the same parent', () => {
        const store = storeOf(3);
        store.link(1, 0);
        store.link(2, 0);
        store.link(1, 0);

        // Re-linking moves it to the end rather than duplicating it.
        expect(store.children(0)).toEqual([2, 1]);
        expect(store.lastChild(0)).toBe(1);
        expect(store.nextSibling(1)).toBe(-1);
    });

    it('moves a whole subtree between parents, maintaining depth', () => {
        const store = storeOf(5);
        store.link(1, 0);
        store.link(2, 1);
        store.link(3, 2);
        store.link(4, 0);
        expect(store.depth(3)).toBe(3);

        // Move node 1 (with 2 and 3 under it) beneath node 4.
        store.link(1, 4);
        expect(store.parent(1)).toBe(4);
        expect(store.children(0)).toEqual([4]);
        expect(store.depth(1)).toBe(2);
        expect(store.depth(2)).toBe(3);
        expect(store.depth(3)).toBe(4);
    });

    it('resets depth to 0 across a subtree that becomes a root', () => {
        const store = storeOf(3);
        store.link(1, 0);
        store.link(2, 1);
        store.unlink(1);
        expect(store.depth(1)).toBe(0);
        expect(store.depth(2)).toBe(1);
    });

    it('orders subtree() parent before child', () => {
        const store = storeOf(5);
        store.link(1, 0);
        store.link(2, 0);
        store.link(3, 1);
        store.link(4, 3);

        const all = store.subtree(0);
        expect(all[0]).toBe(0);
        for (const node of all) {
            const parent = store.parent(node);
            if (parent !== -1 && all.includes(parent)) {
                expect(all.indexOf(parent)).toBeLessThan(all.indexOf(node));
            }
        }
        expect(sorted(all)).toEqual([0, 1, 2, 3, 4]);
    });

    it('omits the root from subtree() when asked', () => {
        const store = storeOf(4);
        store.link(1, 0);
        store.link(2, 1);
        store.link(3, 0);
        expect(sorted(store.subtree(0, [], false))).toEqual([1, 2, 3]);
        expect(store.subtree(0, [], false)).not.toContain(0);
    });

    it('tracks roots in insertion order and drops nodes that get parented', () => {
        const store = storeOf(3);
        expect(store.roots()).toEqual([0, 1, 2]);
        store.link(1, 0);
        expect(store.roots()).toEqual([0, 2]);
        store.unlink(1);
        // Back to a root, now at the end — insertion-defined.
        expect(store.roots()).toEqual([0, 2, 1]);
    });

    it('answers isAncestorOf including the self case, and rejects the reverse', () => {
        const store = storeOf(4);
        store.link(1, 0);
        store.link(2, 1);

        expect(store.isAncestorOf(0, 2)).toBe(true);
        expect(store.isAncestorOf(1, 2)).toBe(true);
        expect(store.isAncestorOf(2, 2)).toBe(true);
        expect(store.isAncestorOf(2, 0)).toBe(false);
        expect(store.isAncestorOf(3, 2)).toBe(false);
    });

    it('refuses a link that would create a cycle', () => {
        const store = storeOf(3);
        store.link(1, 0);
        store.link(2, 1);

        store.link(0, 2);
        // The tree is unchanged and still walkable.
        expect(store.parent(0)).toBe(-1);
        expect(sorted(store.subtree(0))).toEqual([0, 1, 2]);
    });

    it('refuses to parent a node to itself', () => {
        const store = storeOf(1);
        store.link(0, 0);
        expect(store.parent(0)).toBe(-1);
        expect(store.children(0)).toEqual([]);
    });

    it('reuses the caller-supplied out array', () => {
        const store = storeOf(3);
        store.link(1, 0);
        store.link(2, 0);
        const out: number[] = [99];
        expect(store.children(0, out)).toBe(out);
        expect(out).toEqual([1, 2]);
    });
});

describe('slot lifecycle', () => {
    it('preserves earlier slots when the arrays grow', () => {
        const store = new TransformStore();
        store.initSlot(0);
        store.setPosition(0, 1234.5, -6.25, 3);
        store.setTint(0, 0x00ff00);

        // Well past the initial capacity, forcing several doublings.
        store.initSlot(500);
        expect(store.slotCount).toBe(501);
        expect(store.posX(0)).toBe(1234.5);
        expect(store.posY(0)).toBe(-6.25);
        expect(store.tint(0)).toBe(0x00ff00);
        // A freshly grown slot reads defaults, and its tree links read -1, not 0.
        expect(store.scaleX(500)).toBe(1);
        expect(store.anchorX(500)).toBe(0.5);
        expect(store.parent(500)).toBe(-1);
        expect(store.firstChild(500)).toBe(-1);
    });

    it('keeps Float64 precision — the reason it is not Float32', () => {
        const store = storeOf(1);
        // 0.1 is not representable in binary; Float32 would lose it at this magnitude.
        store.setPosition(0, 0.1, 1e15 + 0.5, 0);
        expect(store.posX(0)).toBe(0.1);
        expect(store.posY(0)).toBe(1e15 + 0.5);
    });

    it('resets to defaults with no stale links after release and re-init', () => {
        const store = storeOf(3);
        store.link(1, 0);
        store.link(2, 1);
        store.setPosition(1, 5, 5, 5);
        store.setAlpha(1, 0.1);

        store.releaseSlot(1);
        store.initSlot(1);

        expect(store.posX(1)).toBe(0);
        expect(store.alpha(1)).toBe(1);
        expect(store.parent(1)).toBe(-1);
        expect(store.prevSibling(1)).toBe(-1);
        expect(store.nextSibling(1)).toBe(-1);
        // The old parent must not still list it.
        expect(store.children(0)).toEqual([]);
    });

    it('unlinks a released slot from its parent, leaving the sibling list intact', () => {
        const store = storeOf(4);
        store.link(1, 0);
        store.link(2, 0);
        store.link(3, 0);
        store.releaseSlot(2);
        expect(store.children(0)).toEqual([1, 3]);
        expect(store.nextSibling(1)).toBe(3);
        expect(store.prevSibling(3)).toBe(1);
    });

    it('clears everything', () => {
        const store = storeOf(3);
        store.link(1, 0);
        store.clear();
        expect(store.slotCount).toBe(0);
        expect(store.roots()).toEqual([]);
        expect(store.consumeFlushDirty()).toEqual([]);
    });

    it('treats an out-of-range or non-integer index as absent rather than throwing', () => {
        const store = storeOf(1);
        expect(() => store.setPosition(99, 1, 1, 1)).not.toThrow();
        expect(() => store.setPosition(-1, 1, 1, 1)).not.toThrow();
        expect(() => store.setRotation(1.5, 90)).not.toThrow();
        expect(store.posX(99)).toBe(0);
        expect(store.parent(99)).toBe(-1);
        expect(store.children(99)).toEqual([]);
        expect(store.subtree(99)).toEqual([]);
        expect(store.visible(99)).toBe(false);
    });
});
