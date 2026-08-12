// Structural changes and state writes are separate channels because they differ in volume and
// in what a mark must carry. These marks are output bookkeeping and no snapshot captures them.

import type { EntityId } from '../ids.js';

/** One entry in the ordered structural journal. */
export type StructuralOp =
    | { kind: 'spawn'; id: EntityId; template: string }
    | { kind: 'destroy'; id: EntityId }
    | { kind: 'reparent'; id: EntityId; parent: EntityId }
    | { kind: 'tag'; id: EntityId; tag: string; added: boolean }
    | { kind: 'attach'; id: EntityId; scriptClass: string };

/** One @serverState write; the unit of replication is (host record, field). */
export interface StateMark {
    record: object;
    field: string;
}

// Transform marks are deliberately absent: they live on SimTransformStore, drained separately.
export class ReplicationChannels {
    /** Append-only; order is meaning. */
    readonly #structural: StructuralOp[] = [];
    /** Keyed so a field written twice before a drain replicates once. */
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
