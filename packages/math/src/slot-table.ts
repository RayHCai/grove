// A slot table plus freelist behind generation-packed handles, keyed by branded `Id`.
//
// A handle legitimately outlives its record, so each slot carries a generation: bumping it on
// release makes the stale handle detectable and the caller's write a silent no-op instead of a
// write landing on whatever record reused the slot. Iteration is by ascending slot — creation
// order, the stable order determinism needs — and parallel structure-of-arrays stores address
// the same slot index, which is why reuse is dense and `slotCount` never shrinks.

import {
    FIRST_GENERATION,
    MAX_GENERATION,
    MAX_INDEX,
    handleGeneration,
    handleIndex,
    nextGeneration,
    packHandle,
} from './handle.js';

// Marks a slot out of generations: 0 is never minted, and reusing the slot past the generation
// wrap would reissue a handle it has already handed out.
const RETIRED_GENERATION = 0;

/** A detached copy of a table's slots. Records are cloned, so it tracks no later mutation. */
export interface SlotTableSnapshot<R> {
    records: (R | null)[];
    generations: number[];
    freeList: number[];
    live: number;
}

/**
 * Slot table plus freelist.
 *
 * Records are stored by reference: `create` takes ownership of the object it is handed and
 * `recordAt` gives that same object back for in-place mutation.
 */
export class SlotTable<Id extends number, R> {
    /** Slot -> record, `null` while the slot is free. */
    #records: (R | null)[] = [];

    /** Slot -> generation. `release` bumps it, so it is also what the next mint will use. */
    #generations: number[] = [];

    /** Free slot indices. A stack: the most recently released slot is reused first. */
    #freeList: number[] = [];

    #live = 0;

    /** Names the table in the full-table error, the one place a caller sees it. */
    readonly #label: string;

    constructor(label: string) {
        this.#label = label;
    }

    /** Number of live records. */
    get liveCount(): number {
        return this.#live;
    }

    /** Highest slot index ever allocated, plus one — the bound for a flat scan. */
    get slotCount(): number {
        return this.#records.length;
    }

    /** Allocates a slot (reusing a freed one) and mints a handle. */
    create(record: R): Id {
        const reused = this.#freeList.pop();

        if (reused === undefined) {
            const index = this.#records.length;
            if (index > MAX_INDEX) {
                throw new RangeError(`${this.#label} is full: all ${MAX_INDEX + 1} slots are live`);
            }
            this.#records.push(record);
            this.#generations.push(FIRST_GENERATION);
            this.#live++;
            return this.#mint(index, FIRST_GENERATION);
        }

        // `release` already advanced this slot's generation, so the handle minted here
        // cannot equal the one that was freed.
        const generation = this.#generationAt(reused);
        this.#records[reused] = record;
        this.#live++;
        return this.#mint(reused, generation);
    }

    /** The slot index, or -1 for the null / a stale / an out-of-range handle. Never throws. */
    indexOf(id: Id): number {
        // No slot reaches generation 0, so `<= 0` covers the null handle; the safe-integer guard
        // covers a garbage number cast to an Id, which would make `handleIndex` fractional.
        if (id <= 0 || !Number.isSafeInteger(id)) return -1;

        const index = handleIndex(id);
        if (this.#records[index] == null) return -1;

        return this.#generations[index] === handleGeneration(id) ? index : -1;
    }

    /** The live handle for a slot index; 0 when that slot is free. */
    idAt(index: number): Id {
        // A free, negative, fractional or past-the-end index all read `undefined`, so this needs
        // no separate range check.
        if (this.#records[index] == null) return 0 as unknown as Id;

        return this.#mint(index, this.#generationAt(index));
    }

    /** The mutable record for a live slot; null when free. */
    recordAt(index: number): R | null {
        return this.#records[index] ?? null;
    }

    /** The mutable record a handle addresses; null for the null / a stale handle. */
    record(id: Id): R | null {
        // `recordAt` reads `undefined` for the -1 a rejected handle yields, so no guard is needed.
        return this.recordAt(this.indexOf(id));
    }

    exists(id: Id): boolean {
        return this.indexOf(id) >= 0;
    }

    /** Frees the slot and bumps the generation, so handles minted for it stay stale. */
    release(id: Id): void {
        this.releaseAt(this.indexOf(id));
    }

    /** Bumps the generation and returns the slot to the freelist, unless it has run out of them. */
    releaseAt(index: number): void {
        // Out of range or already free are both no-ops, so a double release cannot put a
        // duplicate index on the freelist.
        if (this.#records[index] == null) return;

        this.#records[index] = null;
        this.#live--;
        if (this.#recycle(index)) this.#freeList.push(index);
    }

    /** Live handles in ascending slot order — creation order. Fills and returns `out` when given. */
    liveIds(out: Id[] = []): Id[] {
        out.length = 0;
        for (let index = 0; index < this.#records.length; index++) {
            if (this.#records[index] != null) out.push(this.idAt(index));
        }
        return out;
    }

    /** Live slot indices, ascending. Fills and returns `out` when given. */
    liveIndices(out: number[] = []): number[] {
        out.length = 0;
        for (let index = 0; index < this.#records.length; index++) {
            if (this.#records[index] != null) out.push(index);
        }
        return out;
    }

    /** Drops every record. Generations still advance, so old handles stay stale. */
    clear(): void {
        for (let index = 0; index < this.#records.length; index++) {
            // An already-free slot had its generation bumped at release; bumping again would burn
            // generations on every clear.
            if (this.#records[index] == null) continue;

            this.#records[index] = null;
            this.#recycle(index);
            this.#live--;
        }

        // Rebuilt descending so the stack pops ascending: reuse stays dense from slot 0, which
        // keeps this table's flat scan — and that of every store indexed by the same slot — short.
        this.#freeList.length = 0;
        for (let index = this.#records.length - 1; index >= 0; index--) {
            if (this.#generations[index] === RETIRED_GENERATION) continue;
            this.#freeList.push(index);
        }

        // Neither array is truncated: dropping the generation history would let a handle from a
        // cleared slot validate again once that slot was re-minted at generation 1.
    }

    /** A detached copy of every slot — the allocating pairing for {@link apply}. */
    capture(cloneRecord: (r: R) => R): SlotTableSnapshot<R> {
        const target: SlotTableSnapshot<R> = {
            records: [],
            generations: [],
            freeList: [],
            live: 0,
        };
        this.captureInto(target, cloneRecord);
        return target;
    }

    /** As `capture`, refilling a snapshot the caller owns and reuses, allocating no array. */
    captureInto(target: SlotTableSnapshot<R>, cloneRecord: (r: R) => R): void {
        target.records.length = this.#records.length;
        for (let index = 0; index < this.#records.length; index++) {
            const record = this.#records[index];
            // Cloned rather than shared: handing back the live object would make the snapshot
            // track every later mutation of it.
            target.records[index] = record == null ? null : cloneRecord(record);
        }
        refill(target.generations, this.#generations);
        refill(target.freeList, this.#freeList);
        target.live = this.#live;
    }

    /** Restores the table from a snapshot, cloning again so the snapshot stays detached. */
    apply(from: SlotTableSnapshot<R>, cloneRecord: (r: R) => R): void {
        this.#records = from.records.map((r) => (r == null ? null : cloneRecord(r)));
        this.#generations = [...from.generations];
        this.#freeList = [...from.freeList];
        this.#live = from.live;
    }

    #mint(index: number, generation: number): Id {
        return packHandle(index, generation) as unknown as Id;
    }

    /** Advances a freed slot's generation, or retires it when the next would wrap; false once retired. */
    #recycle(index: number): boolean {
        const generation = this.#generationAt(index);
        if (generation >= MAX_GENERATION) {
            this.#generations[index] = RETIRED_GENERATION;
            return false;
        }

        this.#generations[index] = nextGeneration(generation);
        return true;
    }

    /** `#generations` is invariantly as long as `#records`; the fallback only satisfies the index check. */
    #generationAt(index: number): number {
        return this.#generations[index] ?? FIRST_GENERATION;
    }
}

/** Overwrites `target` with `source` in place, so a reused snapshot buffer keeps its arrays. */
function refill(target: number[], source: readonly number[]): void {
    target.length = source.length;
    for (let index = 0; index < source.length; index++) target[index] = source[index] as number;
}
