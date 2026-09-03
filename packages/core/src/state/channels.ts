// Structural changes and state writes are separate channels because they differ in volume and
// in what a mark must carry. These marks are output bookkeeping and no snapshot captures them.

import type { ScriptId, ScriptProps } from '@platform/project';
import type { EntityId } from '../ids.js';

/** One indivisible structural change. Every arm names the entity it changes. */
export type SingleStructuralOp =
    | { kind: 'spawn'; id: EntityId; template: string }
    | { kind: 'destroy'; id: EntityId }
    | { kind: 'reparent'; id: EntityId; parent: EntityId }
    | { kind: 'tag'; id: EntityId; tag: string; added: boolean }
    /** The id the bundle stamped, never the class name — a minifier rewrites one and not the other. */
    | { kind: 'attach'; id: EntityId; script: ScriptId; props?: ScriptProps };

/**
 * Every op one template instantiation produced, applied as one.
 *
 * Flat rather than nested: a subtree is emitted depth-first with parents ahead of children, so one
 * level of boundary is all a consumer needs — and a nesting shape would have to be bounded by depth
 * as well as by cardinality before anything could walk it.
 */
export type StructuralGroup = { kind: 'group'; ops: SingleStructuralOp[] };

/** One entry in the ordered structural journal. */
export type StructuralOp = SingleStructuralOp | StructuralGroup;

/** One @serverState write; the unit of replication is (host record, field). */
export interface StateMark {
    record: object;
    field: string;
}

// Transform marks are deliberately absent: they live on SimTransformStore, drained separately.
export class ReplicationChannels {
    /** Append-only; order is meaning. */
    readonly #structural: StructuralOp[] = [];
    /**
     * Keyed so a field written twice before a drain replicates once.
     *
     * Record-major, by object identity, rather than one flat map under a `record field` string:
     * `markState` runs on every assignment to a decorated field, and building the key and the mark
     * before the deduplicating write meant both were garbage for every write after the first.
     * The marks are shaped at drain instead, once per send tick.
     */
    readonly #state = new Map<object, Set<string>>();
    /** Distinct (record, field) pairs held, since the map above counts records, not marks. */
    #markCount = 0;
    /** The open group's ops, or null outside one. */
    #group: SingleStructuralOp[] | null = null;
    /** Open groups, so a template minting a template still produces one flat boundary. */
    #groupDepth = 0;

    markStructural(op: SingleStructuralOp): void {
        if (this.#group !== null) this.#group.push(op);
        else this.#structural.push(op);
    }

    /**
     * Opens a boundary: every op marked until the matching `endGroup` is applied as one.
     *
     * Re-entrant and flattening — a template whose child is itself a template opens a second one,
     * and only the outermost produces an op, because the inner subtree is part of the same
     * instantiation and a receiver gains nothing from being told where it started.
     */
    beginGroup(): void {
        this.#groupDepth += 1;
        if (this.#groupDepth === 1) this.#group = [];
    }

    /** Closes the boundary. An empty group journals nothing; a single op journals itself. */
    endGroup(): void {
        if (this.#groupDepth === 0) return;
        this.#groupDepth -= 1;
        if (this.#groupDepth > 0) return;
        const ops = this.#group ?? [];
        this.#group = null;
        if (ops.length === 0) return;
        // One op is not a group: a boundary around it bounds nothing, and every consumer would pay
        // an unwrap for the ordinary spawn.
        if (ops.length === 1) this.#structural.push(ops[0] as SingleStructuralOp);
        else this.#structural.push({ kind: 'group', ops });
    }

    markState(record: object, field: string): void {
        let fields = this.#state.get(record);
        if (fields === undefined) {
            fields = new Set();
            this.#state.set(record, fields);
        }
        const before = fields.size;
        fields.add(field);
        if (fields.size !== before) this.#markCount += 1;
    }

    drainStructural(): StructuralOp[] {
        const out = [...this.#structural];
        this.#structural.length = 0;
        return out;
    }

    drainState(): StateMark[] {
        const out: StateMark[] = [];
        for (const [record, fields] of this.#state) {
            for (const field of fields) out.push({ record, field });
        }
        this.#state.clear();
        this.#markCount = 0;
        return out;
    }

    get structuralCount(): number {
        return this.#structural.length;
    }
    get stateCount(): number {
        return this.#markCount;
    }

    clear(): void {
        this.#structural.length = 0;
        this.#state.clear();
        this.#markCount = 0;
        this.#group = null;
        this.#groupDepth = 0;
    }
}
