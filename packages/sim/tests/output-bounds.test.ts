// What bounds the server's own output: a per-send structural budget with an ordered spill, and a
// join snapshot divided when one frame cannot carry it.
//
// Both exist because a peer refuses an over-cap frame BEFORE parsing it, and the client's answer to a
// broken session is a resync — which asks for a full snapshot, which is bigger. Nothing recovers on
// its own, and it happens to every connection at once.

import { describe, expect, it } from 'vitest';
import type { ServerToClient, SnapshotChunk, WireStructuralOp } from '@platform/protocol';
import type { Message } from '@platform/transport';
import { MAX_FRAME_BYTES, jsonCodec } from '@platform/transport';
import { MAX_STRUCTURAL_OPS_PER_SEND } from '../src/constants.js';
import { harness } from './harness.js';
import type { Harness, Peer } from './harness.js';

function frameBytes(envelope: ServerToClient): number {
    return jsonCodec.byteLength(jsonCodec.encode(envelope as unknown as Message));
}

/** Spawns straight onto the runtime: the journal is what the budget acts on, not who filled it. */
function spawnMany(h: Harness, count: number, template = 'coin'): void {
    const game = h.sim.runtime.gameInstance!;
    for (let i = 0; i < count; i++) game.spawn(template, i, 0);
}

/**
 * Mints `count` ordered ops on ONE entity, for the cases that need a deep journal and not a big world.
 *
 * Core's broadphase is naive O(n²) over the live set, so a test that reached a deep journal by
 * spawning would spend its time in contacts rather than in what it is measuring.
 */
function tagMany(h: Harness, count: number): string[] {
    const entity = h.sim.runtime.gameInstance!.spawn('coin', 0, 0);
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
        const name = `t${i}`;
        entity.tag(name);
        names.push(name);
    }
    return names;
}

/** Pumps until the peer has been sent `n` state envelopes, so a test never counts ticks by hand. */
function statesUntil(h: Harness, peer: Peer, n: number, limit = 256): void {
    for (let i = 0; i < limit && peer.states.length < n; i++) h.pumpTicks(1);
}

function spawnIds(ops: readonly WireStructuralOp[]): number[] {
    return ops.filter((op) => op.kind === 'spawn').map((op) => op.snapshot.netId as number);
}

describe('the per-send structural budget', () => {
    it('caps one send and carries the rest, in order, over the sends that follow', () => {
        const h = harness();
        const peer = h.joined();
        h.settle([peer]);

        const overflow = 500;
        spawnMany(h, MAX_STRUCTURAL_OPS_PER_SEND + overflow);
        statesUntil(h, peer, 2);

        const first = peer.states[0]!;
        const second = peer.states[1]!;
        expect(first.structural).toHaveLength(MAX_STRUCTURAL_OPS_PER_SEND);
        expect(second.structural).toHaveLength(overflow);

        // Order is meaning: the ops do not commute and the journal is applied verbatim, so a spill
        // that reordered anything would create a node for an entity that no longer exists.
        const ids = [...spawnIds(first.structural), ...spawnIds(second.structural)];
        expect(ids).toHaveLength(MAX_STRUCTURAL_OPS_PER_SEND + overflow);
        expect(ids).toStrictEqual(ids.toSorted((a, b) => a - b));
    });

    it('keeps the reliable envelope inside the frame cap the peer would refuse it at', () => {
        const h = harness();
        const peer = h.joined();
        h.settle([peer]);

        // Three sends' worth minted in one tick — the runaway the budget exists for. Unbounded, this
        // is one envelope no peer would parse; bounded, it is three every peer will.
        const names = tagMany(h, MAX_STRUCTURAL_OPS_PER_SEND * 3);
        statesUntil(h, peer, 4);

        // The state envelope is what the budget bounds — the transform channel is droppable by
        // construction and carries no journal, so it is not what an op storm inflates.
        for (const envelope of peer.states) {
            expect(frameBytes(envelope)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
            expect(envelope.structural.length).toBeLessThanOrEqual(MAX_STRUCTURAL_OPS_PER_SEND);
        }

        // Nothing is lost on the way: the journal arrives whole, and in the order it was written.
        const tags = peer.states
            .flatMap((s) => s.structural)
            .filter((op) => op.kind === 'tag')
            .map((op) => op.tag);
        expect(tags).toStrictEqual(names);
    });

    it('never replays held-over ops at a client whose snapshot already holds them', () => {
        const h = harness();
        const first = h.joined();
        h.settle([first]);

        spawnMany(h, MAX_STRUCTURAL_OPS_PER_SEND + 500);
        statesUntil(h, first, 1);

        // Joins while ops are still held over. Its snapshot is read from LIVE state, so it already
        // contains them — replaying would mint a second copy, and a duplicate spawn is not idempotent.
        const late = h.connect();
        late.join('late');
        for (let i = 0; i < 64 && late.welcome === undefined; i++) h.pumpTicks(1);
        const known = new Set(late.welcome!.snapshot.entities.map((e) => e.netId as number));
        expect(known.size).toBeGreaterThanOrEqual(MAX_STRUCTURAL_OPS_PER_SEND + 500);

        statesUntil(h, late, 3);
        const replayed = late.states
            .flatMap((s) => spawnIds(s.structural))
            .filter((id) => known.has(id));
        expect(replayed).toStrictEqual([]);
    });
});

describe('a join snapshot too big for one frame', () => {
    // A wide template rather than a huge count: it is the BYTES that have to cross the cap, and 4000
    // entities carrying a kilobyte of template each does it without a slow test.
    const WIDE = 'w'.repeat(1024);
    const COUNT = 4_000;

    it('is divided into chunks that each fit, and the join still succeeds', () => {
        const h = harness();
        spawnMany(h, COUNT, WIDE);
        const peer = h.joined();

        const chunks = peer.received.filter((e): e is SnapshotChunk => e.kind === 'snapshot-chunk');
        expect(chunks.length).toBeGreaterThan(0);
        expect(peer.welcome!.snapshotChunks).toBe(chunks.length);

        // The whole point: nothing the server minted is a frame the peer would refuse unparsed.
        for (const envelope of peer.received) {
            expect(frameBytes(envelope)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
        }
    });

    it('carries the whole world across the set, in one order', () => {
        const h = harness();
        spawnMany(h, COUNT, WIDE);
        const peer = h.joined();

        const chunks = peer.received.filter((e): e is SnapshotChunk => e.kind === 'snapshot-chunk');
        // Chunks precede the Welcome, so the client folds them AHEAD of the welcome's own remainder.
        const entities = [...chunks.flatMap((c) => c.entities), ...peer.welcome!.snapshot.entities];
        expect(entities).toHaveLength(COUNT);

        // Indices are dense and ascending, which is what lets the receiver reject a short set rather
        // than open a session on a world missing entities the server believes it sent.
        expect(chunks.map((c) => c.index)).toStrictEqual(chunks.map((_, at) => at));
    });

    it('leaves a world that fits alone, with no chunk and no count', () => {
        const h = harness();
        spawnMany(h, 10);
        const peer = h.joined();

        expect(peer.received.some((e) => e.kind === 'snapshot-chunk')).toBe(false);
        expect(peer.welcome!.snapshotChunks).toBeUndefined();
        expect(peer.welcome!.snapshot.entities).toHaveLength(10);
    });
});
