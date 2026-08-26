// Dividing a join snapshot that one frame cannot carry.
//
// Transport's cap bounds what a single parse allocates, so it is the peer's protection and not a
// number a producer may raise. A world big enough to exceed it is divided here instead, and the
// client reassembles before it applies anything — a half-applied world is worse than a slow join.
//
// Sized by MEASURING each element rather than by counting them: an `EntitySnapshot` is seven numbers
// and two strings, but `template` and `tags` are creator-authored and a `StateDiff` carries whatever
// a `@serverState` field holds, so element count says little about bytes.

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

/**
 * Divides `snapshot` into a head plus as many chunks as its byte budget requires.
 *
 * The head keeps the tick and the roster and nothing else: both are bounded — a tick is a scalar and
 * the roster by `maxPlayers` — while `entities` and `state` are the two that grow with the world.
 * Emptying them rather than filling the head to the brim keeps this one rule instead of two.
 */
export function splitSnapshot(
    snapshot: WorldSnapshot,
    codec: Codec,
    budget: number,
): SplitSnapshot {
    const entities = pack(snapshot.entities, codec, budget);
    const state = pack(snapshot.state, codec, budget);

    const chunks: SnapshotChunk[] = [];
    // Entities before state, and each group in its own order: `entities` is parents-before-children,
    // which the client checks, and a `StateDiff` addressing an entity needs that entity to exist.
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

/**
 * Greedily fills groups whose measured bytes stay under `budget`, in the order given.
 *
 * One `encode` per element, which is real work — but it happens once per join and only for a world
 * already too big for one frame, and estimating from an average would let one heavy element push a
 * chunk over the cap, which is the failure this exists to prevent.
 */
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
        // Nothing can carry it, and a chunk built around it would be refused by the peer exactly as
        // the whole snapshot was. Dropped and counted, like an unrepresentable mark.
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

/**
 * One element's encoded size, plus the comma and brackets an array spends on it.
 *
 * An element the codec refuses reads as unbounded, so `pack` drops it rather than letting the throw
 * abort a join — the same contract `encodeStateValue` already holds for a mark.
 */
function measure(item: unknown, codec: Codec): number {
    try {
        return codec.byteLength(codec.encode(item as Message)) + 1;
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}
