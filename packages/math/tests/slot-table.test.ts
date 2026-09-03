// Contract tests for the slot table.
//
// Four properties carry the whole design and each fails silently when broken: a released handle
// must never equal the handle that reuses its slot, a stale handle must read as absent instead of
// landing on its replacement, reuse must stay dense from slot 0 because parallel
// structure-of-arrays stores are scanned flat over the same slot indices, and a slot out of
// generations must be retired rather than re-mint a handle it already gave out.

import { describe, it, expect } from 'vitest';
import {
    FIRST_GENERATION,
    MAX_GENERATION,
    MAX_INDEX,
    handleGeneration,
    handleIndex,
} from '../src/handle.js';
import type { SlotTableSnapshot } from '../src/slot-table.js';
import { SlotTable } from '../src/slot-table.js';
import * as math from '../src/index.js';

type TestId = number & { readonly __testId: unique symbol };

interface Rec {
    name: string;
    tags: string[];
}

const rec = (name: string): Rec => ({ name, tags: [name] });

const cloneRec = (r: Rec): Rec => ({ name: r.name, tags: [...r.tags] });

const table = (label = 'SlotTable'): SlotTable<TestId, Rec> => new SlotTable<TestId, Rec>(label);

describe('create', () => {
    it('hands out ascending slots while nothing has been released', () => {
        const t = table();
        const a = t.create(rec('a'));
        const b = t.create(rec('b'));
        const c = t.create(rec('c'));
        expect([t.indexOf(a), t.indexOf(b), t.indexOf(c)]).toEqual([0, 1, 2]);
        expect(t.liveCount).toBe(3);
        expect(t.slotCount).toBe(3);
    });

    it('mints the first generation for a fresh slot', () => {
        const t = table();
        expect(handleGeneration(t.create(rec('a')))).toBe(FIRST_GENERATION);
    });

    it('reuses the most recently released slot first', () => {
        const t = table();
        const a = t.create(rec('a'));
        const b = t.create(rec('b'));
        t.create(rec('c'));
        t.release(b);
        t.release(a);

        expect(t.indexOf(t.create(rec('d')))).toBe(0);
        expect(t.indexOf(t.create(rec('e')))).toBe(1);
        // The freelist is empty again, so the next slot is appended.
        expect(t.indexOf(t.create(rec('f')))).toBe(3);
        expect(t.slotCount).toBe(4);
    });

    it('never mints the handle it just freed for that slot', () => {
        const t = table();
        const a = t.create(rec('a'));
        t.release(a);
        const reused = t.create(rec('b'));
        expect(handleIndex(reused)).toBe(handleIndex(a));
        expect(reused).not.toBe(a);
        expect(handleGeneration(reused)).toBe(handleGeneration(a) + 1);
    });

    it('takes ownership of the record it is handed', () => {
        const t = table();
        const record = rec('a');
        const id = t.create(record);
        expect(t.record(id)).toBe(record);
        expect(t.recordAt(0)).toBe(record);
    });

    it.each(['EntityTable', 'NodeStore'])('names itself in the full-table error: %s', (label) => {
        const t = table(label);
        // Filling 2^24 slots through `create` is not testable, so the table is restored from a
        // snapshot whose slot array already reaches the cap — the next slot is one past the end.
        const atCap: (Rec | null)[] = [];
        atCap.length = MAX_INDEX + 1;
        t.apply({ records: atCap, generations: [], freeList: [], live: 0 }, cloneRec);

        expect(t.slotCount).toBe(MAX_INDEX + 1);
        expect(() => t.create(rec('a'))).toThrow(RangeError);
        expect(() => t.create(rec('a'))).toThrow(`${label} is full: all 16777216 slots are live`);
    });
});

describe('indexOf', () => {
    it('refuses the null handle, negatives, fractionals and huge numbers without throwing', () => {
        const t = table();
        t.create(rec('a'));
        for (const bad of [
            0,
            -1,
            -16_777_217,
            1.5,
            16_777_216.5,
            Number.MAX_VALUE,
            Infinity,
            NaN,
        ]) {
            expect(t.indexOf(bad as TestId)).toBe(-1);
        }
    });

    it('refuses a handle for a slot that was never allocated', () => {
        const t = table();
        t.create(rec('a'));
        expect(t.indexOf(math.packHandle(9, FIRST_GENERATION) as TestId)).toBe(-1);
    });

    it('refuses a stale handle whose slot is live again', () => {
        const t = table();
        const a = t.create(rec('a'));
        t.release(a);
        const b = t.create(rec('b'));
        expect(t.indexOf(a)).toBe(-1);
        expect(t.indexOf(b)).toBe(0);
    });
});

describe('reads through a stale handle', () => {
    it('report absence instead of the replacement record', () => {
        const t = table();
        const a = t.create(rec('a'));
        t.release(a);
        const b = t.create(rec('b'));

        expect(t.exists(a)).toBe(false);
        expect(t.record(a)).toBeNull();
        expect(t.exists(b)).toBe(true);
        expect(t.record(b)?.name).toBe('b');
    });

    it('makes a release through a stale handle a no-op', () => {
        const t = table();
        const a = t.create(rec('a'));
        t.release(a);
        const b = t.create(rec('b'));

        t.release(a);
        expect(t.exists(b)).toBe(true);
        expect(t.liveCount).toBe(1);
    });

    it('never puts a duplicate index on the freelist when released twice', () => {
        const t = table();
        t.create(rec('a'));
        const b = t.create(rec('b'));
        t.create(rec('c'));

        t.release(b);
        t.release(b);
        expect(t.liveCount).toBe(2);

        const x = t.create(rec('x'));
        const y = t.create(rec('y'));
        expect(t.indexOf(x)).toBe(1);
        expect(t.indexOf(y)).toBe(3);
    });
});

describe('idAt / recordAt', () => {
    it('reads the live handle back from a slot index', () => {
        const t = table();
        const a = t.create(rec('a'));
        expect(t.idAt(0)).toBe(a);
    });

    it('reads 0 and null for a free, negative, fractional or past-the-end slot', () => {
        const t = table();
        const a = t.create(rec('a'));
        t.release(a);
        for (const index of [0, -1, 1.5, 99]) {
            expect(t.idAt(index)).toBe(0);
            expect(t.recordAt(index)).toBeNull();
        }
    });
});

describe('release / releaseAt', () => {
    it('frees by handle and by slot index alike', () => {
        const t = table();
        const a = t.create(rec('a'));
        const b = t.create(rec('b'));

        t.release(a);
        t.releaseAt(t.indexOf(b));
        expect(t.liveCount).toBe(0);
        expect(t.slotCount).toBe(2);
        expect(t.exists(a)).toBe(false);
        expect(t.exists(b)).toBe(false);
    });

    it('ignores an out-of-range or already-free slot index', () => {
        const t = table();
        t.create(rec('a'));
        t.releaseAt(-1);
        t.releaseAt(7);
        t.releaseAt(1.5);
        expect(t.liveCount).toBe(1);
    });
});

describe('liveIds / liveIndices', () => {
    it('ascend by slot and skip the freed ones', () => {
        const t = table();
        const a = t.create(rec('a'));
        const b = t.create(rec('b'));
        const c = t.create(rec('c'));
        const d = t.create(rec('d'));
        t.release(b);

        expect(t.liveIndices()).toEqual([0, 2, 3]);
        expect(t.liveIds()).toEqual([a, c, d]);
    });

    it('refill the array they are handed and return it', () => {
        const t = table();
        const a = t.create(rec('a'));

        const ids: TestId[] = [999 as TestId, 998 as TestId];
        const indices = [7, 8, 9];
        expect(t.liveIds(ids)).toBe(ids);
        expect(t.liveIndices(indices)).toBe(indices);
        expect(ids).toEqual([a]);
        expect(indices).toEqual([0]);
    });
});

describe('clear', () => {
    it('drops every record and leaves every old handle stale', () => {
        const t = table();
        const a = t.create(rec('a'));
        const b = t.create(rec('b'));
        t.clear();

        expect(t.liveCount).toBe(0);
        expect(t.exists(a)).toBe(false);
        expect(t.exists(b)).toBe(false);
        expect(t.record(a)).toBeNull();
        // The generation history survives, so slot 0 does not re-mint at generation 1.
        expect(t.slotCount).toBe(2);
    });

    it('rebuilds the freelist so reuse ascends from slot 0', () => {
        const t = table();
        t.create(rec('a'));
        t.create(rec('b'));
        t.create(rec('c'));
        t.clear();

        expect(t.indexOf(t.create(rec('d')))).toBe(0);
        expect(t.indexOf(t.create(rec('e')))).toBe(1);
        expect(t.indexOf(t.create(rec('f')))).toBe(2);
        expect(t.slotCount).toBe(3);
    });

    it('does not bump the generation of a slot that was already free', () => {
        const t = table();
        t.create(rec('a'));
        const b = t.create(rec('b'));
        t.create(rec('c'));
        t.release(b);
        t.clear();

        const ids = [t.create(rec('d')), t.create(rec('e')), t.create(rec('f'))];
        expect(ids.map((id) => handleIndex(id))).toEqual([0, 1, 2]);
        expect(ids.map((id) => handleGeneration(id))).toEqual([2, 2, 2]);
    });
});

describe('the generation wrap', () => {
    // Reaching `MAX_GENERATION` through `release` alone is 2^29 cycles of one slot, so the slot is
    // fast-forwarded through a snapshot and the last few generations are then spent for real.
    const atGeneration = (t: SlotTable<TestId, Rec>, generation: number, name: string): void => {
        t.apply(
            { records: [rec(name)], generations: [generation], freeList: [], live: 1 },
            cloneRec,
        );
    };

    it('retires the slot rather than re-mint a handle it already gave out', () => {
        const t = table();
        const first = t.create(rec('a'));
        expect(handleGeneration(first)).toBe(FIRST_GENERATION);

        atGeneration(t, MAX_GENERATION - 2, 'a');
        for (let cycle = 0; cycle < 2; cycle++) {
            t.releaseAt(0);
            expect(t.indexOf(t.create(rec('cycle')))).toBe(0);
        }
        // The slot is live at MAX_GENERATION; one more release is the wrap.
        t.releaseAt(0);

        // Without retirement the freelist hands slot 0 back at FIRST_GENERATION, `next` equals
        // `first`, and a handle some other entity is still holding reads and writes this record.
        const next = t.create(rec('after-wrap'));
        expect(next).not.toBe(first);
        expect(t.indexOf(next)).toBe(1);
        expect(t.slotCount).toBe(2);

        expect(t.exists(first)).toBe(false);
        expect(t.record(first)).toBeNull();
        expect(t.idAt(0)).toBe(0);
    });

    it('leaves a retired slot out of the freelist that `clear` rebuilds', () => {
        const t = table();
        atGeneration(t, MAX_GENERATION, 'a');
        t.releaseAt(0);
        t.create(rec('b'));
        t.clear();

        expect(t.indexOf(t.create(rec('c')))).toBe(1);
        expect(t.indexOf(t.create(rec('d')))).toBe(2);
    });

    it('carries the retirement through a capture and back', () => {
        const t = table();
        atGeneration(t, MAX_GENERATION, 'a');
        const outstanding = t.idAt(0);
        t.releaseAt(0);

        const snapshot = t.capture(cloneRec);
        expect(snapshot.freeList).toEqual([]);

        t.apply(snapshot, cloneRec);
        expect(t.indexOf(t.create(rec('b')))).toBe(1);
        expect(t.exists(outstanding)).toBe(false);
    });
});

describe('capture / apply', () => {
    it('clones records so the snapshot does not track later mutation', () => {
        const t = table();
        const id = t.create(rec('a'));
        const snapshot = t.capture(cloneRec);

        t.record(id)!.name = 'mutated';
        t.record(id)!.tags.push('extra');
        expect(snapshot.records[0]?.name).toBe('a');
        expect(snapshot.records[0]?.tags).toEqual(['a']);
    });

    it('clones records on the way back in, so the table does not track the snapshot', () => {
        const t = table();
        const id = t.create(rec('a'));
        const snapshot = t.capture(cloneRec);

        t.apply(snapshot, cloneRec);
        const restored = t.record(id)!;
        restored.name = 'mutated';
        restored.tags.push('extra');
        expect(snapshot.records[0]?.name).toBe('a');
        expect(snapshot.records[0]?.tags).toEqual(['a']);

        snapshot.records[0]!.name = 'snapshot-side';
        expect(t.record(id)!.name).toBe('mutated');
    });

    it('copies the generations and freelist as fresh arrays', () => {
        const t = table();
        const a = t.create(rec('a'));
        t.create(rec('b'));
        const snapshot = t.capture(cloneRec);
        expect(snapshot.freeList).toEqual([]);
        expect(snapshot.generations).toEqual([FIRST_GENERATION, FIRST_GENERATION]);

        t.release(a);
        expect(snapshot.freeList).toEqual([]);
        expect(snapshot.generations).toEqual([FIRST_GENERATION, FIRST_GENERATION]);
        expect(snapshot.live).toBe(2);
    });

    it('restores the live count, the slots and the staleness of a handle', () => {
        const t = table();
        const a = t.create(rec('a'));
        const b = t.create(rec('b'));
        const snapshot = t.capture(cloneRec);

        t.release(a);
        t.clear();
        t.apply(snapshot, cloneRec);

        expect(t.liveCount).toBe(2);
        expect(t.slotCount).toBe(2);
        expect(t.exists(a)).toBe(true);
        expect(t.exists(b)).toBe(true);
        expect(t.record(a)?.name).toBe('a');
        expect(t.liveIds()).toEqual([a, b]);
    });

    it('restores into a table that never held the records', () => {
        const source = table();
        const a = source.create(rec('a'));
        const snapshot: SlotTableSnapshot<Rec> = source.capture(cloneRec);

        const target = table();
        target.apply(snapshot, cloneRec);
        expect(target.record(a)?.name).toBe('a');
        expect(target.liveCount).toBe(1);
    });
});

describe('captureInto', () => {
    it('refills a caller-owned snapshot in place', () => {
        const t = table();
        const a = t.create(rec('a'));
        const target: SlotTableSnapshot<Rec> = {
            records: [rec('stale'), rec('stale')],
            generations: [7, 7],
            freeList: [1],
            live: 2,
        };

        const { records, generations, freeList } = target;

        t.captureInto(target, cloneRec);
        expect(target.records.map((r) => r?.name)).toEqual(['a']);
        expect(target.generations).toEqual([FIRST_GENERATION]);
        expect(target.freeList).toEqual([]);
        expect(target.live).toBe(1);
        // The caller's own arrays, refilled: a per-tick capture that replaced them would allocate
        // three arrays a frame and defeat the buffer.
        expect(target.records).toBe(records);
        expect(target.generations).toBe(generations);
        expect(target.freeList).toBe(freeList);

        t.release(a);
        const b = t.create(rec('b'));
        t.captureInto(target, cloneRec);
        expect(target.records.map((r) => r?.name)).toEqual(['b']);
        expect(target.live).toBe(1);
        expect(t.exists(b)).toBe(true);
    });

    it('deep-copies records and shares no array with the table', () => {
        const t = table();
        const id = t.create(rec('a'));
        const target: SlotTableSnapshot<Rec> = {
            records: [],
            generations: [],
            freeList: [],
            live: 0,
        };
        t.captureInto(target, cloneRec);

        t.record(id)!.name = 'mutated';
        t.record(id)!.tags.push('extra');
        expect(target.records[0]?.name).toBe('a');
        expect(target.records[0]?.tags).toEqual(['a']);

        // Writing the snapshot's own arrays must not reach the table.
        target.records.push(rec('appended'));
        target.generations.push(99);
        target.freeList.push(0);
        expect(t.slotCount).toBe(1);
        expect(t.liveIds()).toEqual([id]);
        expect(t.record(id)!.name).toBe('mutated');
    });

    it('agrees with capture on the same table', () => {
        const t = table();
        t.create(rec('a'));
        const released = t.create(rec('b'));
        t.create(rec('c'));
        t.release(released);

        const allocated = t.capture(cloneRec);
        const target: SlotTableSnapshot<Rec> = {
            records: [],
            generations: [],
            freeList: [],
            live: 0,
        };
        t.captureInto(target, cloneRec);
        expect(target).toEqual(allocated);
    });
});

describe('index re-exports', () => {
    it('exposes the slot table and its snapshot type', () => {
        expect(math.SlotTable).toBe(SlotTable);
        // Type-only: fails to compile if the snapshot type stops being re-exported.
        const snapshot: math.SlotTableSnapshot<Rec> = table().capture(cloneRec);
        expect(snapshot.live).toBe(0);
    });
});
