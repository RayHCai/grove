// Host records: @serverState lives on the host, not the declaring script (DESIGN §5.1,
// §6.1). One record per host — game, player, entity instance — holds the values. The
// getter reads the record; the setter writes it and marks the state channel (§5.2).
//
// The record also carries a per-field TYPE TAG for restore validation (§5.2 step 3) and
// the set of bound wrappers on this host.

export type TypeTag =
    | { kind: 'number' | 'string' | 'boolean' | 'undefined' | 'null' }
    | { kind: 'object' | 'array'; shape: string };

export interface HostRecord {
    /** Stable id of the host: 'game', a player id, or an entity id string. */
    readonly hostId: string;
    /** Field name → current value. */
    readonly values: Map<string, unknown>;
    /** Field name → declared type tag, for restore validation. */
    readonly tags: Map<string, TypeTag>;
    /** Field names that are bound wrappers rather than decorated fields. */
    readonly wrappers: Set<string>;
}

export function createHostRecord(hostId: string): HostRecord {
    return {
        hostId,
        values: new Map(),
        tags: new Map(),
        wrappers: new Set(),
    };
}

/** The primitive-kind tag of a value, plus a shape hash for readonly objects/arrays. */
export function tagOf(value: unknown): TypeTag {
    if (value === null) return { kind: 'null' };
    if (value === undefined) return { kind: 'undefined' };
    if (Array.isArray(value)) return { kind: 'array', shape: shapeHash(value) };
    const t = typeof value;
    if (t === 'number' || t === 'string' || t === 'boolean') return { kind: t };
    if (t === 'object') return { kind: 'object', shape: shapeHash(value) };
    return { kind: 'undefined' };
}

/** A cheap structural hash: the sorted key set and element kinds, one level deep. */
function shapeHash(value: unknown): string {
    if (Array.isArray(value)) {
        const kinds = new Set(value.map(v => primitiveKind(v)));
        return `[${[...kinds].toSorted().join('|')}]`;
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value as Record<string, unknown>).toSorted();
        return `{${keys.map(k => `${k}:${primitiveKind((value as Record<string, unknown>)[k])}`).join(',')}}`;
    }
    return primitiveKind(value);
}

function primitiveKind(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

export function tagsMatch(a: TypeTag, b: TypeTag): boolean {
    if (a.kind !== b.kind) return false;
    if ((a.kind === 'object' || a.kind === 'array') && (b.kind === 'object' || b.kind === 'array')) {
        return a.shape === b.shape;
    }
    return true;
}
