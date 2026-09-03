// Pure. The slot table behind `NodeId`, holding the non-numeric per-node data; the numeric
// transform data lives in transform-store.ts, addressed by the same slot index — which is why
// slots reuse densely and `slotCount` never shrinks.
//
// The table itself is `@platform/math`'s: generations, the freelist and stale-handle detection are
// identical to the engine's entity table, and one copy is what keeps them identical.

import { SlotTable } from '@platform/math';
import type { NodeId } from './node-id.js';
import type { Surface, TextStyle, UiAnchor } from './renderer.js';

export type NodeKind = 'sprite' | 'group' | 'text';

/** The per-node data that is not part of the transform SoA. */
export interface NodeRecord {
    kind: NodeKind;
    surface: Surface;
    /** Asset name for a sprite; '' for group and text. */
    texture: string;
    /** Current string for a text node; '' otherwise. */
    text: string;
    style: TextStyle | undefined;
    uiAnchor: UiAnchor | undefined;
    /** Draw order within the surface; sibling order once parented. */
    layer: number;
    /**
     * Creation sequence number: the freelist is LIFO, so a slot index would sort a node created
     * into a recycled slot underneath the node it was drawn on top of.
     */
    ordinal: number;
}

/**
 * Slot table plus freelist for renderer nodes.
 *
 * Records are stored by reference: `create` takes ownership of the object it is handed and
 * `recordAt` gives that same object back for in-place mutation.
 */
export class NodeStore {
    // A TypeScript `private`, not `#`: the generation-wrap test forces a generation through the
    // capture/apply pair, which has no public route in from a `#` field.
    private readonly slots = new SlotTable<NodeId, NodeRecord>('NodeStore');

    /** Number of live nodes. */
    get liveCount(): number {
        return this.slots.liveCount;
    }

    /** Highest slot index ever allocated, plus one — the bound for a flat scan. */
    get slotCount(): number {
        return this.slots.slotCount;
    }

    /** Allocates a slot (reusing a freed one) and mints a handle. */
    create(record: NodeRecord): NodeId {
        return this.slots.create(record);
    }

    /** The slot index, or -1 for NO_NODE, a stale or an out-of-range handle. Never throws. */
    indexOf(id: NodeId): number {
        return this.slots.indexOf(id);
    }

    isAlive(id: NodeId): boolean {
        return this.slots.exists(id);
    }

    /** The live handle for a slot index; NO_NODE when that slot is free. */
    idAt(index: number): NodeId {
        return this.slots.idAt(index);
    }

    /** The mutable record for a live slot; null when free. */
    recordAt(index: number): NodeRecord | null {
        return this.slots.recordAt(index);
    }

    /** Bumps the generation and returns the slot to the freelist. Takes a slot index. */
    release(index: number): void {
        this.slots.releaseAt(index);
    }

    /** Live slot indices, ascending. Fills and returns `out` when given. */
    liveIndices(out: number[] = []): number[] {
        return this.slots.liveIndices(out);
    }

    /** Drops every node. Generations still advance, so old handles stay stale. */
    clear(): void {
        this.slots.clear();
    }
}
