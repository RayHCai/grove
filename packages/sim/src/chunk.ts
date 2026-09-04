// Transport's frame cap is the peer's protection, not a number a producer may raise, so a world too
// big for one frame is divided here instead.

import type { SnapshotChunk, WorldSnapshot } from '@platform/protocol';
import type { Codec, Message } from '@platform/transport';

/** A snapshot divided so that every frame it produces is under the caller's byte budget. */
export interface SplitSnapshot {
    /** What stays on the `Welcome`: the tick, the roster, and whatever fitted alongside them. */
    head: WorldSnapshot;
    /** Sent ahead of the `Welcome`, in this order. */
    chunks: SnapshotChunk[];
    /** Elements no frame could carry even alone, so a silent loss is visible. */
    dropped: number;
}

/** Divides `snapshot` into a head plus as many chunks as its byte budget requires. */
export function splitSnapshot(
    snapshot: WorldSnapshot,
    codec: Codec,
    budget: number,
): SplitSnapshot {
    const entities = pack(snapshot.entities, codec, budget);
    const state = pack(snapshot.state, codec, budget);

    const chunks: SnapshotChunk[] = [];
    // Entities before state, each group in its own order: a `StateDiff` addressing an entity needs
    // that entity to exist, and `entities` is parents-before-children, which the client checks.
    for (const group of entities.groups) {
        chunks.push({ kind: 'snapshot-chunk', index: chunks.length, entities: group, state: [] });
    }
    for (const group of state.groups) {
        chunks.push({ kind: 'snapshot-chunk', index: chunks.length, entities: [], state: group });
    }

    return {
        head: { ...snapshot, entities: [], state: [] },
        chunks,
        dropped: entities.dropped + state.dropped,
    };
}

/** Greedily fills groups whose measured bytes stay under `budget`, in the order given. */
function pack<T>(
    items: readonly T[],
    codec: Codec,
    budget: number,
): { groups: T[][]; dropped: number } {
    const groups: T[][] = [];
    let current: T[] = [];
    let used = 0;
    let dropped = 0;

    for (const item of items) {
        const size = measure(item, codec);
        if (size > budget) {
            dropped += 1;
            continue;
        }
        if (used + size > budget && current.length > 0) {
            groups.push(current);
            current = [];
            used = 0;
        }
        current.push(item);
        used += size;
    }
    if (current.length > 0) groups.push(current);
    return { groups, dropped };
}

/** One element's encoded size, plus the separator an array spends on it; one the codec refuses reads as unbounded, so `pack` drops it. */
function measure(item: unknown, codec: Codec): number {
    try {
        return codec.byteLength(codec.encode(item as Message)) + 1;
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}
