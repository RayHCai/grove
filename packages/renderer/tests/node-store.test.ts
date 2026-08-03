// Slot table, freelist and generation behaviour (§7).
//
// The contract under test is that a handle is only ever valid for the node it was minted
// for: a released slot MUST be handed out again (dense reuse keeps the flat scan short),
// and the handle it is handed out with MUST NOT equal the one that was freed.

import { describe, it, expect } from 'vitest';
import {
    MAX_GENERATION,
    NO_NODE,
    nodeGeneration,
    nodeIndex,
    packNodeId,
    type NodeId,
} from '../src/node-id.js';
import { NodeStore, type NodeRecord } from '../src/node-store.js';
import type { Surface } from '../src/renderer.js';

function record(overrides: Partial<NodeRecord> = {}): NodeRecord {
    return {
        kind: 'sprite',
        surface: 'world' as Surface,
        texture: 'hero',
        text: '',
        style: undefined,
        uiAnchor: undefined,
        layer: 0,
        ...overrides,
    };
}

/** Forces a slot's generation, so wrap-around is testable without 2^29 release cycles. */
function pokeGeneration(store: NodeStore, index: number, generation: number): void {
    const internals = store as unknown as { generations: number[] };
    internals.generations[index] = generation;
}

describe('handle lifecycle', () => {
    it('starts slots at index 0 / generation 1 and counts up', () => {
        const store = new NodeStore();
        expect(store.liveCount).toBe(0);
        expect(store.slotCount).toBe(0);

        const a = store.create(record());
        const b = store.create(record());

        expect(nodeIndex(a)).toBe(0);
        expect(nodeGeneration(a)).toBe(1);
        expect(nodeIndex(b)).toBe(1);
        expect(nodeGeneration(b)).toBe(1);
        expect(a).not.toBe(NO_NODE);

        expect(store.liveCount).toBe(2);
        expect(store.slotCount).toBe(2);
    });

    it('resolves a live handle to its slot and back', () => {
        const store = new NodeStore();
        const a = store.create(record());
        const b = store.create(record());

        expect(store.indexOf(a)).toBe(0);
        expect(store.indexOf(b)).toBe(1);
        expect(store.idAt(0)).toBe(a);
        expect(store.idAt(1)).toBe(b);
        expect(store.isAlive(a)).toBe(true);
    });

    it('stores the record by reference so callers can mutate in place', () => {
        const store = new NodeStore();
        const original = record({ layer: 7 });
        const id = store.create(original);

        const fetched = store.recordAt(store.indexOf(id));
        expect(fetched).toBe(original);

        fetched!.layer = 42;
        expect(store.recordAt(0)?.layer).toBe(42);
    });

    it('keeps per-slot records distinct', () => {
        const store = new NodeStore();
        store.create(record({ kind: 'group', texture: '' }));
        store.create(record({ kind: 'text', surface: 'ui', texture: '', text: 'hi' }));

        expect(store.recordAt(0)?.kind).toBe('group');
        expect(store.recordAt(1)?.kind).toBe('text');
        expect(store.recordAt(1)?.surface).toBe('ui');
        expect(store.recordAt(1)?.text).toBe('hi');
    });
});

describe('freelist reuse', () => {
    it('hands the freed slot index back out with a different handle', () => {
        const store = new NodeStore();
        store.create(record()); // slot 0, kept live
        const doomed = store.create(record()); // slot 1
        expect(nodeIndex(doomed)).toBe(1);

        store.release(1);
        expect(store.liveCount).toBe(1);
        expect(store.slotCount).toBe(2);

        const reused = store.create(record());
        expect(nodeIndex(reused)).toBe(1); // same slot
        expect(reused).not.toBe(doomed); // different handle
        expect(nodeGeneration(reused)).toBe(nodeGeneration(doomed) + 1);
        expect(store.slotCount).toBe(2); // no growth
        expect(store.liveCount).toBe(2);
    });

    it('reuses before growing', () => {
        const store = new NodeStore();
        const ids = [store.create(record()), store.create(record()), store.create(record())];
        store.release(nodeIndex(ids[1]!));
        store.release(nodeIndex(ids[0]!));

        // Stack order: the most recent release comes back first.
        expect(nodeIndex(store.create(record()))).toBe(0);
        expect(nodeIndex(store.create(record()))).toBe(1);
        expect(store.slotCount).toBe(3);

        // Freelist drained — now it grows.
        expect(nodeIndex(store.create(record()))).toBe(3);
        expect(store.slotCount).toBe(4);
    });

    it('treats a double release as a no-op rather than duplicating the free slot', () => {
        const store = new NodeStore();
        store.create(record());
        store.create(record());

        store.release(0);
        store.release(0);
        expect(store.liveCount).toBe(1);

        // A duplicated freelist entry would hand slot 0 out twice, aliasing two nodes.
        const first = store.create(record());
        const second = store.create(record());
        expect(nodeIndex(first)).toBe(0);
        expect(nodeIndex(second)).toBe(2);
        expect(store.liveCount).toBe(3);
    });

    it('ignores a release of a never-allocated or out-of-range slot', () => {
        const store = new NodeStore();
        store.create(record());

        store.release(1);
        store.release(-1);
        store.release(99_999);
        store.release(0.5);

        expect(store.liveCount).toBe(1);
        expect(store.slotCount).toBe(1);
        expect(store.isAlive(store.idAt(0))).toBe(true);
    });
});

describe('stale handle rejection', () => {
    it('rejects a handle after its slot is released', () => {
        const store = new NodeStore();
        const id = store.create(record());

        store.release(0);

        expect(store.indexOf(id)).toBe(-1);
        expect(store.isAlive(id)).toBe(false);
        expect(store.recordAt(0)).toBeNull();
        expect(store.idAt(0)).toBe(NO_NODE);
    });

    it('rejects the old handle after the slot is reused', () => {
        const store = new NodeStore();
        const old = store.create(record({ texture: 'old' }));
        store.release(0);
        const fresh = store.create(record({ texture: 'new' }));

        expect(store.indexOf(old)).toBe(-1);
        expect(store.isAlive(old)).toBe(false);
        expect(store.indexOf(fresh)).toBe(0);
        expect(store.recordAt(0)?.texture).toBe('new');
    });

    it('never throws for NO_NODE, an out-of-range or a malformed handle', () => {
        const store = new NodeStore();
        store.create(record());

        expect(store.indexOf(NO_NODE)).toBe(-1);
        expect(store.isAlive(NO_NODE)).toBe(false);
        expect(store.indexOf(packNodeId(500, 1))).toBe(-1); // slot never allocated
        expect(store.indexOf(packNodeId(0, 99))).toBe(-1); // wrong generation
        expect(store.indexOf(-5 as NodeId)).toBe(-1);
        expect(store.indexOf(1.5 as NodeId)).toBe(-1);
        expect(store.indexOf(Number.NaN as NodeId)).toBe(-1);
        expect(store.indexOf(Number.POSITIVE_INFINITY as NodeId)).toBe(-1);
        expect(store.indexOf((Number.MAX_SAFE_INTEGER + 10) as NodeId)).toBe(-1);
    });

    it('reports NO_NODE / null for a free or out-of-range slot lookup', () => {
        const store = new NodeStore();
        store.create(record());
        store.release(0);

        expect(store.idAt(0)).toBe(NO_NODE);
        expect(store.idAt(1)).toBe(NO_NODE);
        expect(store.idAt(-1)).toBe(NO_NODE);
        expect(store.recordAt(0)).toBeNull();
        expect(store.recordAt(7)).toBeNull();
        expect(store.recordAt(-1)).toBeNull();
    });
});

describe('generations', () => {
    it('advances one generation per release, staying positive past 128 (§7)', () => {
        const store = new NodeStore();
        let id = store.create(record());
        expect(nodeGeneration(id)).toBe(1);

        // Cycles slot 0 well past the int32 wrap point: with `gen << 24` the handle would
        // have gone negative at generation 128.
        for (let cycle = 0; cycle < 200; cycle++) {
            store.release(0);
            id = store.create(record());
            expect(store.indexOf(id)).toBe(0);
            expect(id).toBeGreaterThan(0);
            expect(Number.isSafeInteger(id)).toBe(true);
        }

        expect(nodeGeneration(id)).toBe(201);
        expect(id).toBe(packNodeId(0, 201));
        expect(store.slotCount).toBe(1);
        expect(store.liveCount).toBe(1);
    });

    it('invalidates every previously minted handle for a slot', () => {
        const store = new NodeStore();
        const history: NodeId[] = [];
        for (let cycle = 0; cycle < 130; cycle++) {
            history.push(store.create(record()));
            store.release(0);
        }
        const current = store.create(record());

        for (const stale of history) {
            expect(store.isAlive(stale)).toBe(false);
        }
        expect(store.isAlive(current)).toBe(true);
        expect(new Set(history).size).toBe(history.length); // no handle ever repeated
    });

    it('wraps to generation 1 instead of leaving the safe-integer range', () => {
        const store = new NodeStore();
        const first = store.create(record());
        expect(nodeGeneration(first)).toBe(1);

        pokeGeneration(store, 0, MAX_GENERATION - 1);
        store.release(0);
        const nearMax = store.create(record());
        expect(nodeGeneration(nearMax)).toBe(MAX_GENERATION);
        expect(Number.isSafeInteger(nearMax)).toBe(true);
        expect(nearMax).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);

        store.release(0);
        const wrapped = store.create(record());
        expect(nodeGeneration(wrapped)).toBe(1);
        expect(Number.isSafeInteger(wrapped)).toBe(true);
        // The documented cost of wrapping: after 2^29 reuses of ONE slot, a generation-1
        // handle validates again. Unreachable in practice, and strictly better than
        // arithmetic that has stopped being exact.
        expect(wrapped).toBe(first);
        expect(store.isAlive(wrapped)).toBe(true);
    });

    it('wraps from MAX_GENERATION on the very next release', () => {
        const store = new NodeStore();
        store.create(record());
        pokeGeneration(store, 0, MAX_GENERATION);

        store.release(0);
        expect(nodeGeneration(store.create(record()))).toBe(1);
    });
});

describe('liveIndices', () => {
    it('returns live slots in ascending order with holes skipped', () => {
        const store = new NodeStore();
        for (let i = 0; i < 5; i++) store.create(record());

        store.release(3);
        store.release(1);

        expect(store.liveIndices()).toEqual([0, 2, 4]);
    });

    it('stays ascending after reuse, not in reuse order', () => {
        const store = new NodeStore();
        for (let i = 0; i < 4; i++) store.create(record());
        store.release(0);
        store.release(2);
        store.create(record()); // reuses slot 2 (stack order)
        store.create(record()); // reuses slot 0

        expect(store.liveIndices()).toEqual([0, 1, 2, 3]);
    });

    it('fills and returns the provided array, discarding prior contents', () => {
        const store = new NodeStore();
        store.create(record());
        store.create(record());
        store.release(0);

        const out = [99, 98, 97];
        const returned = store.liveIndices(out);
        expect(returned).toBe(out);
        expect(out).toEqual([1]);
    });

    it('is empty for an empty store', () => {
        expect(new NodeStore().liveIndices()).toEqual([]);
    });
});

describe('clear', () => {
    it('drops every node and invalidates every outstanding handle', () => {
        const store = new NodeStore();
        const ids = [store.create(record()), store.create(record()), store.create(record())];
        store.release(1); // one already-free slot in the mix

        store.clear();

        expect(store.liveCount).toBe(0);
        expect(store.liveIndices()).toEqual([]);
        for (const id of ids) {
            expect(store.isAlive(id)).toBe(false);
            expect(store.indexOf(id)).toBe(-1);
        }
        expect(store.recordAt(0)).toBeNull();
        expect(store.idAt(0)).toBe(NO_NODE);
    });

    it('keeps slotCount, so generation history is not lost', () => {
        const store = new NodeStore();
        const a = store.create(record());
        store.create(record());

        store.clear();
        expect(store.slotCount).toBe(2);

        // A truncating clear would re-mint slot 0 at generation 1 and revalidate `a`.
        const reborn = store.create(record());
        expect(nodeIndex(reborn)).toBe(0);
        expect(reborn).not.toBe(a);
        expect(store.isAlive(a)).toBe(false);
    });

    it('does not double-bump a slot that was already free', () => {
        const store = new NodeStore();
        store.create(record());
        store.release(0); // generation 1 -> 2
        store.clear(); // must stay at 2

        expect(nodeGeneration(store.create(record()))).toBe(2);
    });

    it('refills dense from slot 0 so reuse stays compact', () => {
        const store = new NodeStore();
        for (let i = 0; i < 4; i++) store.create(record());
        store.clear();

        expect(nodeIndex(store.create(record()))).toBe(0);
        expect(nodeIndex(store.create(record()))).toBe(1);
        expect(nodeIndex(store.create(record()))).toBe(2);
        expect(store.slotCount).toBe(4);
    });

    it('is idempotent and safe on an empty store', () => {
        const store = new NodeStore();
        store.clear();
        store.clear();
        expect(store.liveCount).toBe(0);
        expect(store.slotCount).toBe(0);
        expect(nodeIndex(store.create(record()))).toBe(0);
    });
});

describe('accounting under churn', () => {
    it('tracks liveCount and slotCount across a mixed create/release sequence', () => {
        const store = new NodeStore();
        const live = new Set<NodeId>();

        for (let i = 0; i < 50; i++) {
            live.add(store.create(record({ layer: i })));
        }
        expect(store.liveCount).toBe(50);
        expect(store.slotCount).toBe(50);

        // Drop every third slot.
        for (let index = 0; index < 50; index += 3) {
            live.delete(store.idAt(index));
            store.release(index);
        }
        const released = Math.ceil(50 / 3);
        expect(store.liveCount).toBe(50 - released);
        expect(store.slotCount).toBe(50); // released slots are not forgotten
        expect(store.liveIndices().length).toBe(50 - released);

        // Refill: every create must land in a hole before the store grows.
        for (let i = 0; i < released; i++) {
            live.add(store.create(record()));
        }
        expect(store.liveCount).toBe(50);
        expect(store.slotCount).toBe(50);
        expect(live.size).toBe(50);

        for (const id of live) {
            expect(store.isAlive(id)).toBe(true);
            expect(store.idAt(store.indexOf(id))).toBe(id);
        }
    });
});
