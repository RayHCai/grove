// Property tests for the slot table, driven by a random operation sequence.
//
// Every other test of this class pins a sequence someone thought to write down, and the sequences
// that break an allocator are the ones nobody did: a release folded into a clear folded into a
// reuse, a snapshot applied over a table that has since moved on. The model here is a plain map of
// handle to record and a set of handles the caller has let go — it reimplements no freelist, so
// agreeing with it is evidence rather than a restatement of the same algorithm twice.
//
// The sequence is seeded from a constant rather than `Math.random`, so a failure is a fixed input
// that replays. A bug in `SeededRandom` would change which sequence runs, never make one pass.

import { describe, it, expect } from 'vitest';
import { handleIndex } from '../src/handle.js';
import { SeededRandom } from '../src/random.js';
import { SlotTable } from '../src/slot-table.js';

type TestId = number & { readonly __testId: unique symbol };

interface Rec {
    name: string;
}

const cloneRec = (r: Rec): Rec => ({ name: r.name });

const SEED = 0x5eed_1e55;

/** The caller's whole view of a table: what it is holding, and what it has let go of. */
class Model {
    live = new Map<TestId, string>();
    dead = new Set<TestId>();
    minted = new Set<TestId>();
    peakLive = 0;

    byIndex(index: number): TestId | undefined {
        for (const id of this.live.keys()) if (handleIndex(id) === index) return id;
        return undefined;
    }

    born(id: TestId, name: string): void {
        this.live.set(id, name);
        this.minted.add(id);
        this.peakLive = Math.max(this.peakLive, this.live.size);
    }

    buried(id: TestId): void {
        this.live.delete(id);
        this.dead.add(id);
    }

    buriedAll(): void {
        for (const id of this.live.keys()) this.dead.add(id);
        this.live.clear();
    }
}

/** Everything a caller can observe, checked against the model in one pass. */
function audit(t: SlotTable<TestId, Rec>, model: Model): void {
    expect(t.liveCount).toBe(model.live.size);
    // Slots are only appended when every existing one is live, so the table never grows past the
    // most records that were alive at once — the density every parallel structure-of-arrays
    // store's flat scan depends on, and the thing a mislaid freelist quietly costs.
    expect(t.slotCount).toBeLessThanOrEqual(model.peakLive);

    for (const [id, name] of model.live) {
        expect(t.exists(id)).toBe(true);
        expect(t.record(id)?.name).toBe(name);
        expect(t.idAt(t.indexOf(id))).toBe(id);
    }

    // A handle the caller released must read as absent, never as the record that took its slot.
    for (const id of model.dead) {
        expect(t.exists(id)).toBe(false);
        expect(t.record(id)).toBeNull();
        expect(t.indexOf(id)).toBe(-1);
    }

    const indices = t.liveIndices();
    expect(indices.length).toBe(model.live.size);
    for (let i = 0; i < indices.length; i++) {
        // Strictly ascending covers both the creation order iteration promises and the absence of
        // a slot listed twice, which a duplicated freelist entry would produce.
        if (i > 0) expect(indices[i]!).toBeGreaterThan(indices[i - 1]!);
        expect(indices[i]!).toBeLessThan(t.slotCount);
    }

    expect(t.liveIds()).toStrictEqual(indices.map((index) => t.idAt(index)));
    expect(t.liveIds().map((id) => handleIndex(id))).toStrictEqual(indices);
}

const LIVE_CAP = 200;

describe('a random create / release / clear sequence', () => {
    it('never hands the same handle out twice', () => {
        const rng = new SeededRandom(SEED);
        const t = new SlotTable<TestId, Rec>('Property');
        const model = new Model();
        let born = 0;

        for (let step = 0; step < 6000; step++) {
            const roll = rng.next();

            if (roll < 0.45 && model.live.size < LIVE_CAP) {
                const name = `r${born++}`;
                const id = t.create({ name });
                // The property the whole generation scheme exists for: no handle is ever reissued,
                // so a stale one can never be mistaken for the record that replaced it.
                expect(model.minted.has(id)).toBe(false);
                model.born(id, name);
            } else if (roll < 0.72) {
                const ids = [...model.live.keys()];
                if (ids.length > 0) {
                    const id = ids[Math.floor(rng.next() * ids.length)]!;
                    t.release(id);
                    model.buried(id);
                }
            } else if (roll < 0.82) {
                // Releasing something already gone must not disturb the table or the freelist.
                const ids = [...model.dead];
                if (ids.length > 0) t.release(ids[Math.floor(rng.next() * ids.length)]!);
            } else if (roll < 0.95) {
                // Deliberately reaches past both ends, where `releaseAt` must be a no-op.
                const index = Math.floor(rng.next() * (t.slotCount + 4)) - 2;
                const id = model.byIndex(index);
                t.releaseAt(index);
                if (id !== undefined) model.buried(id);
            } else {
                t.clear();
                model.buriedAll();
            }

            expect(t.liveCount).toBe(model.live.size);
            expect(t.slotCount).toBeLessThanOrEqual(model.peakLive);

            if (step % 200 === 0) audit(t, model);
        }

        audit(t, model);
        expect(born).toBeGreaterThan(1000);
        expect(model.dead.size).toBeGreaterThan(500);
    });
});

describe('a random sequence rewound through capture / apply', () => {
    it('restores the table the snapshot was taken from, and refuses the discarded future', () => {
        const rng = new SeededRandom(SEED ^ 0x1234);
        const t = new SlotTable<TestId, Rec>('Property');
        const model = new Model();
        let born = 0;

        const churn = (steps: number): void => {
            for (let step = 0; step < steps; step++) {
                const roll = rng.next();
                if (roll < 0.55 && model.live.size < LIVE_CAP) {
                    const name = `r${born++}`;
                    model.born(t.create({ name }), name);
                } else if (roll < 0.9) {
                    const ids = [...model.live.keys()];
                    if (ids.length > 0) {
                        const id = ids[Math.floor(rng.next() * ids.length)]!;
                        t.release(id);
                        model.buried(id);
                    }
                } else {
                    t.clear();
                    model.buriedAll();
                }
            }
        };

        for (let round = 0; round < 40; round++) {
            churn(60);

            const snapshot = t.capture(cloneRec);
            const restored = new Map(model.live);

            churn(60);
            t.apply(snapshot, cloneRec);

            // A rewind puts back exactly the handles that were live when it was taken; every
            // handle the discarded branch minted must read as absent rather than land on a slot
            // the snapshot has since refilled.
            model.live = restored;
            model.dead = new Set([...model.minted].filter((id) => !restored.has(id)));
            audit(t, model);
        }

        expect(born).toBeGreaterThan(2000);
    });
});
