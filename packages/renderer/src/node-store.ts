// Pure. The slot table behind `NodeId`, holding the non-numeric per-node data; the numeric
// transform data lives in transform-store.ts, addressed by the same slot index — which is why
// slots reuse densely and `slotCount` never shrinks.
//
// A handle legitimately outlives its node, so each slot carries a generation: bumping it on
// release makes the stale handle detectable and the caller's write a silent no-op instead of a
// write landing on whatever node reused the slot.

import type { NodeId } from './node-id.js';
import {
    MAX_GENERATION,
    MAX_INDEX,
    NO_NODE,
    nodeGeneration,
    nodeIndex,
    packNodeId,
} from './node-id.js';
import type { Surface, TextStyle, UiAnchor } from './renderer.js';

/** Generations start at 1, so a zeroed field is never a valid handle. */
const FIRST_GENERATION = 1;

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
}

/**
 * The generation a slot moves to when it is freed.
 *
 * Wraps rather than growing without bound: past `MAX_GENERATION` a packed handle leaves the
 * safe-integer range, where distinct handles start comparing equal. A handle held across 2^29
 * reuses of one slot could then alias a live node — unreachable in practice, and better than
 * arithmetic that has silently stopped being exact.
 */
function nextGeneration(generation: number): number {
    return generation >= MAX_GENERATION ? FIRST_GENERATION : generation + 1;
}

/**
 * Slot table plus freelist for renderer nodes.
 *
 * Records are stored by reference: `create` takes ownership of the object it is handed and
 * `recordAt` gives that same object back for in-place mutation.
 */
export class NodeStore {
    /** Slot -> record, `null` while the slot is free. */
    private readonly records: (NodeRecord | null)[] = [];

    /** Slot -> generation. `release` bumps it, so it is also what the next mint will use. */
    private readonly generations: number[] = [];

    /** Free slot indices. A stack: the most recently released slot is reused first. */
    private readonly freeList: number[] = [];

    private live = 0;

    /** Number of live nodes. */
    get liveCount(): number {
        return this.live;
    }

    /** Highest slot index ever allocated, plus one — the bound for a flat scan. */
    get slotCount(): number {
        return this.records.length;
    }

    /** Allocates a slot (reusing a freed one) and mints a handle. */
    create(record: NodeRecord): NodeId {
        const reused = this.freeList.pop();

        if (reused === undefined) {
            const index = this.records.length;
            if (index > MAX_INDEX) {
                throw new RangeError(`NodeStore is full: all ${MAX_INDEX + 1} slots are live`);
            }
            this.records.push(record);
            this.generations.push(FIRST_GENERATION);
            this.live++;
            return packNodeId(index, FIRST_GENERATION);
        }

        // `release` already advanced this slot's generation, so the handle minted here
        // cannot equal the one that was freed.
        const generation = this.generations[reused] ?? FIRST_GENERATION;
        this.records[reused] = record;
        this.live++;
        return packNodeId(reused, generation);
    }

    /** The slot index, or -1 for NO_NODE, a stale or an out-of-range handle. Never throws. */
    indexOf(id: NodeId): number {
        // No slot reaches generation 0, so `<= 0` covers NO_NODE; the safe-integer guard covers a
        // garbage number cast to a NodeId, which would make `nodeIndex` fractional.
        if (id <= 0 || !Number.isSafeInteger(id)) return -1;

        const index = nodeIndex(id);
        const record = this.records[index];
        if (record == null) return -1;

        return this.generations[index] === nodeGeneration(id) ? index : -1;
    }

    isAlive(id: NodeId): boolean {
        return this.indexOf(id) >= 0;
    }

    /** The live handle for a slot index; NO_NODE when that slot is free. */
    idAt(index: number): NodeId {
        // A free, negative, fractional or past-the-end index all read `undefined`, so this needs
        // no separate range check.
        if (this.records[index] == null) return NO_NODE;

        const generation = this.generations[index] ?? FIRST_GENERATION;
        return packNodeId(index, generation);
    }

    /** The mutable record for a live slot; null when free. */
    recordAt(index: number): NodeRecord | null {
        return this.records[index] ?? null;
    }

    /** Bumps the generation and returns the slot to the freelist. */
    release(index: number): void {
        // Out of range or already free are both no-ops, so a double release cannot put a
        // duplicate index on the freelist.
        if (this.records[index] == null) return;

        this.records[index] = null;
        this.generations[index] = nextGeneration(this.generations[index] ?? FIRST_GENERATION);
        this.freeList.push(index);
        this.live--;
    }

    /** Live slot indices, ascending. Fills and returns `out` when given. */
    liveIndices(out: number[] = []): number[] {
        out.length = 0;
        for (let index = 0; index < this.records.length; index++) {
            if (this.records[index] != null) out.push(index);
        }
        return out;
    }

    /** Drops every node. Generations still advance, so old handles stay stale. */
    clear(): void {
        for (let index = 0; index < this.records.length; index++) {
            // An already-free slot had its generation bumped at release; bumping again would burn
            // generations on every clear.
            if (this.records[index] == null) continue;

            this.records[index] = null;
            this.generations[index] = nextGeneration(this.generations[index] ?? FIRST_GENERATION);
            this.live--;
        }

        // Rebuilt descending so the stack pops ascending: reuse stays dense from slot 0, which
        // keeps this store's flat scan — and transform-store's — short.
        this.freeList.length = 0;
        for (let index = this.records.length - 1; index >= 0; index--) {
            this.freeList.push(index);
        }

        // Neither array is truncated: dropping the generation history would let a handle from a
        // cleared slot validate again once that slot was re-minted at generation 1.
    }
}
