// The three replication channels (DESIGN §5.1). One dirty set is the wrong shape:
// server→client traffic is three populations differing by orders of magnitude in volume,
// delivery requirements, and what a mark must say. Every mutation path writes to exactly
// one. These marks are OUTPUT bookkeeping — deliberately NOT captured by snapshot (§8.1).

import type { EntityId } from '../ids.js';

/** structural — spawn, destroy, reparent, tag, script attach. Ordered, reliable journal. */
export type StructuralOp =
    | { kind: 'spawn'; id: EntityId; template: string }
    | { kind: 'destroy'; id: EntityId }
    | { kind: 'reparent'; id: EntityId; parent: EntityId }
    | { kind: 'tag'; id: EntityId; tag: string; added: boolean }
    | { kind: 'attach'; id: EntityId; scriptClass: string };

/** state — a @serverState write. Reliable, per-player scoped. Unit is (hostRecord, field). */
export interface StateMark {
    record: object;
    field: string;
}

// The TRANSFORM channel is not here: it is the SimTransformStore's own dense per-entity
// bitset, with two independent drains — the server's ReplicationSink and the client's
// SceneSink, each clearing what it consumes (§5.1). Keeping it on the store is what lets
// those two drains be independent; a shared set here would have one steal the other's
// marks. So ReplicationChannels owns only the structural journal and the state set.
export class ReplicationChannels {
    /** Append-only journal; order is meaning (§5.1). */
    readonly #structural: StructuralOp[] = [];
    /** Set of (record, field) pairs, keyed for dedup. */
    readonly #state = new Map<string, StateMark>();
    #stateKeySeq = new WeakMap<object, number>();
    #nextRecordId = 1;

    markStructural(op: StructuralOp): void {
        this.#structural.push(op);
    }

    markState(record: object, field: string): void {
        let recordId = this.#stateKeySeq.get(record);
        if (recordId === undefined) {
            recordId = this.#nextRecordId++;
            this.#stateKeySeq.set(record, recordId);
        }
        this.#state.set(`${recordId} ${field}`, { record, field });
    }

    // ─── drains (§5.1: the sink decides cadence) ────────────────────────────────

    drainStructural(): StructuralOp[] {
        const out = [...this.#structural];
        this.#structural.length = 0;
        return out;
    }

    drainState(): StateMark[] {
        const out = [...this.#state.values()];
        this.#state.clear();
        return out;
    }

    // ─── inspection (tests) ─────────────────────────────────────────────────────

    get structuralCount(): number {
        return this.#structural.length;
    }
    get stateCount(): number {
        return this.#state.size;
    }

    clear(): void {
        this.#structural.length = 0;
        this.#state.clear();
    }
}
