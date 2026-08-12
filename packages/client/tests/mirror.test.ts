// The mirror: server ids never leak, apply order and envelope pairing, the mark discard,
// and nothing writing outside apply.

import { afterEach, describe, expect, it } from 'vitest';
import { clearRuntime } from '@platform/core';
import type { NetId, StateEnvelope, WireStructuralOp } from '@platform/protocol';
import { Mirror } from '../src/mirror.js';
import { entity, transformDiff, wireTransform } from './fake-server.js';

const BOUNDS = { left: -400, right: 400, top: 300, bottom: -300 };

function mirror(simRate = 60): Mirror {
    return new Mirror({ simRate, bounds: BOUNDS, regions: [] });
}

function stateEnvelope(
    structural: WireStructuralOp[] = [],
    over: Partial<StateEnvelope> = {},
): StateEnvelope {
    return { kind: 'state', tick: 1, ackSeq: 0, structural, state: [], ...over };
}

afterEach(() => clearRuntime());

describe('a peer-chosen netId has to be plausible', () => {
    it('drops and counts a spawn whose netId could not name a server handle', () => {
        const m = mirror();
        const delta = m.applyState(
            stateEnvelope([
                { kind: 'spawn', snapshot: entity(-1) },
                { kind: 'spawn', snapshot: entity(1.5) },
                { kind: 'spawn', snapshot: entity(Number.MAX_SAFE_INTEGER + 2) },
                { kind: 'spawn', snapshot: entity(7) },
            ]),
        );

        // Only the plausible one entered the map, and the rest are counted rather than thrown.
        expect(delta.added).toHaveLength(1);
        expect(m.counters.invalidNetId).toBe(3);
        // And nothing keyed the map on a value no later op could address.
        expect(
            m.applyState(stateEnvelope([{ kind: 'destroy', netId: 1.5 as NetId }])).removed,
        ).toHaveLength(0);
    });
});

describe('the script-less runtime', () => {
    it('is a client runtime, so Loop.step would not capture the lag ring', () => {
        const m = mirror();
        expect(m.runtime.isServer).toBe(false);
        // The ring object still exists on a client runtime, so the guard is `isServer`, not absence.
        expect(m.runtime.lagRing).toBeDefined();
    });

    it('replaces every pass with a no-op, so nothing simulates', () => {
        const m = mirror();
        const passes = m.runtime.passes;
        expect(passes).toBeDefined();
        // Each is present and inert: calling them must not throw and must not move anything.
        const e = m.runtime.entityManager.spawn('thing', 5, 7);
        passes?.movement(1 / 60, undefined);
        passes?.countdowns();
        expect(m.runtime.transforms.posX(e.entityId)).toBe(5);
    });

    it('carries no scripts, so the instance registry is empty', () => {
        expect([...mirror().runtime.instances.all()]).toHaveLength(0);
    });

    it('snapshots the six stores prediction needs, and round-trips a moved position', () => {
        const m = mirror();
        const e = m.runtime.entityManager.spawn('thing', 1, 2);
        const snap = m.loop.snapshot();
        expect(snap.entries.map((captured) => captured.store.storeName).toSorted()).toEqual(
            ['breaker', 'entities', 'prng', 'tags', 'timers', 'transforms'].toSorted(),
        );
        m.runtime.transforms.setPosition(e.entityId, 99, 99, 0);
        m.loop.restore(snap);
        expect(m.runtime.transforms.posX(e.entityId)).toBe(1);
    });
});

describe('server ids never leak', () => {
    it('produces a local id set that differs from the wire netIds', () => {
        const m = mirror();
        // The wire's worked example: a server that spawned a, b, destroyed a, then spawned c
        // holds [33554432, 16777217], where a client told only about the live entities holds
        // [16777216, 16777217]. Asserted as SETS, not per-element — the second handle coincides, and
        // an assertion that every id differs would be false for a reason that is not a leak.
        const delta = m.applyState(
            stateEnvelope([
                { kind: 'spawn', snapshot: entity(33554432) },
                { kind: 'spawn', snapshot: entity(16777217) },
            ]),
        );
        expect(delta.added.map(Number)).toEqual([16777216, 16777217]);
        expect(delta.added.map(Number)).not.toEqual([33554432, 16777217]);
        // And every read resolves through the map.
        expect(m.index.local(33554432 as NetId)).toBe(delta.added[0]);
        expect(m.index.local(16777217 as NetId)).toBe(delta.added[1]);
    });

    it('drops and counts an op naming an unknown netId, without throwing', () => {
        const m = mirror();
        expect(() =>
            m.applyState(
                stateEnvelope([
                    { kind: 'destroy', netId: 999 as NetId },
                    { kind: 'tag', netId: 999 as NetId, tag: 'x', added: true },
                ]),
            ),
        ).not.toThrow();
        expect(m.counters.unknownNetId).toBe(2);
    });
});

describe('apply order and the envelope pairing', () => {
    it('holds a TransformEnvelope whose tick has no StateEnvelope yet, then applies it', () => {
        const m = mirror();
        const delta = m.applyState(
            stateEnvelope([{ kind: 'spawn', snapshot: entity(1, 'thing') }], { tick: 5 }),
        );
        const local = delta.added[0]!;

        // A transform for a LATER tick is held, not applied.
        m.applyTransforms({
            kind: 'transform',
            tick: 6,
            transform: [transformDiff(1, { posX: 50 })],
        });
        expect(m.runtime.transforms.posX(local)).toBe(0);

        // Once tick 6's state envelope lands, it applies — landing at the TRANSFORM's position rather
        // than the spawn's, which pins it against `initSlot`'s zeroing.
        m.applyState(stateEnvelope([], { tick: 6 }));
        expect(m.runtime.transforms.posX(local)).toBe(50);
    });

    it('a spawn with no transform envelope at all lands at its AUTHORED transform, not the origin', () => {
        // The regression test for the backpressure interaction: transform is dropped first, and a
        // static entity is dirty exactly once — at spawn.
        const m = mirror();
        const delta = m.applyState(
            stateEnvelope([
                {
                    kind: 'spawn',
                    snapshot: entity(1, 'wall', {
                        transform: wireTransform({
                            posX: 12,
                            posY: 34,
                            scale: 3,
                            layer: 2,
                            rot: 90,
                        }),
                    }),
                },
            ]),
        );
        const local = delta.added[0]!;
        expect(m.runtime.transforms.posX(local)).toBe(12);
        expect(m.runtime.transforms.posY(local)).toBe(34);
        expect(m.runtime.transforms.scale(local)).toBe(3);
        expect(m.runtime.transforms.layer(local)).toBe(2);
        expect(m.runtime.transforms.rotation(local)).toBe(90);
    });

    it('preserves journal order verbatim: spawn then destroy leaves nothing', () => {
        const m = mirror();
        const delta = m.applyState(
            stateEnvelope([
                { kind: 'spawn', snapshot: entity(1) },
                { kind: 'destroy', netId: 1 as NetId },
            ]),
        );
        expect(delta.added).toHaveLength(1);
        expect(delta.removed).toHaveLength(1);
        expect(m.runtime.entities.isAlive(delta.added[0]!)).toBe(false);
        expect(m.index.has(1 as NetId)).toBe(false);
    });

    it('applies tags, so game.find answers correctly', () => {
        const m = mirror();
        const delta = m.applyState(
            stateEnvelope([
                { kind: 'spawn', snapshot: entity(1, 'coin', { tags: ['pickup', 'shiny'] }) },
            ]),
        );
        expect(m.runtime.tags.tagsOf(delta.added[0]!)).toEqual(['pickup', 'shiny']);
    });

    it('applies reparent, and a null parent detaches', () => {
        const m = mirror();
        const delta = m.applyState(
            stateEnvelope([
                { kind: 'spawn', snapshot: entity(1, 'parent') },
                { kind: 'spawn', snapshot: entity(2, 'child') },
            ]),
        );
        const [parent, child] = delta.added;

        m.applyState(stateEnvelope([{ kind: 'reparent', netId: 2 as NetId, parent: 1 as NetId }]));
        expect(m.runtime.entities.record(child as never)?.parent).toBe(parent);

        m.applyState(stateEnvelope([{ kind: 'reparent', netId: 2 as NetId, parent: null }]));
        expect(m.runtime.entities.record(child as never)?.parent).toBe(0);
    });

    it('roots AND COUNTS a child whose parent has not been mapped', () => {
        // A wire requirement no receiver checks is one that quietly stops holding.
        const m = mirror();
        const delta = m.applyState(
            stateEnvelope([
                { kind: 'spawn', snapshot: entity(2, 'child', { parent: 1 as NetId }) },
            ]),
        );
        expect(m.counters.outOfOrderParent).toBe(1);
        expect(m.runtime.entities.record(delta.added[0]!)?.parent).toBe(0);
    });

    it('tears leave-interest down bottom-up, so a parent leaving never orphans a child', () => {
        const m = mirror();
        const delta = m.applyState(
            stateEnvelope([
                { kind: 'spawn', snapshot: entity(1, 'parent') },
                { kind: 'spawn', snapshot: entity(2, 'child', { parent: 1 as NetId }) },
            ]),
        );
        const [parent, child] = delta.added as [never, never];
        expect(m.runtime.entities.record(child)?.parent).toBe(parent);

        m.applyState(stateEnvelope([{ kind: 'leave-interest', netId: 1 as NetId }]));
        // Core's cascade flips the whole subtree, so neither survives and no orphan is left rooted.
        expect(m.runtime.entities.isAlive(parent)).toBe(false);
        expect(m.runtime.entities.isAlive(child)).toBe(false);
    });

    it('treats enter-interest as spawn, through the one applier', () => {
        const m = mirror();
        const delta = m.applyState(
            stateEnvelope([
                {
                    kind: 'enter-interest',
                    snapshot: entity(7, 'thing', { transform: wireTransform({ posX: 3 }) }),
                },
            ]),
        );
        expect(delta.added).toHaveLength(1);
        expect(m.runtime.transforms.posX(delta.added[0]!)).toBe(3);
    });

    it('drops attach with a counter, instantiating no scripts', () => {
        const m = mirror();
        m.applyState(
            stateEnvelope([
                { kind: 'spawn', snapshot: entity(1) },
                { kind: 'attach', netId: 1 as NetId, scriptClass: 'PlayerController' },
            ]),
        );
        expect(m.counters.droppedAttach).toBe(1);
        expect([...m.runtime.instances.all()]).toHaveLength(0);
    });
});

describe('the roster populates from the wire', () => {
    it('makes a joined player visible to PlayerManager and keeps the wire index', () => {
        const m = mirror();
        const delta = m.applyState(
            stateEnvelope([{ kind: 'player-join', player: { id: 'p9', index: 4, name: 'Nine' } }]),
        );
        expect(delta.joined).toHaveLength(1);
        const player = m.runtime.playerManager?.byId('p9');
        expect(player?.name).toBe('Nine');
        // The wire's index wins: core's own counter would have said 0 and drifted from the server's.
        expect(player?.index).toBe(4);
        expect(m.runtime.hosts.get('player:p9')).toBeDefined();
    });

    it('removes both the record and the host on player-leave', () => {
        const m = mirror();
        m.applyState(
            stateEnvelope([{ kind: 'player-join', player: { id: 'p9', index: 0, name: 'N' } }]),
        );
        const delta = m.applyState(stateEnvelope([{ kind: 'player-leave', id: 'p9' }]));
        expect(delta.left).toEqual(['p9']);
        expect(m.runtime.playerManager?.byId('p9')).toBeNull();
        expect(m.runtime.hosts.get('player:p9')).toBeUndefined();
    });
});

describe('@serverState lands in the host record', () => {
    it('writes the game record, addressed by kind', () => {
        const m = mirror();
        m.applyState(
            stateEnvelope([], {
                state: [{ host: { kind: 'game' }, fields: { timeLeft: 42 } }],
            }),
        );
        expect(m.runtime.hosts.ensure('game').record.values.get('timeLeft')).toBe(42);
    });

    it('writes a player record under core’s prefixed key, not the bare id', () => {
        const m = mirror();
        m.applyState(
            stateEnvelope([], {
                state: [{ host: { kind: 'player', id: 'p1' }, fields: { coins: 7 } }],
            }),
        );
        // An unprefixed key would silently create a second, empty record where no reader looks.
        expect(m.runtime.hosts.get('player:p1')?.record.values.get('coins')).toBe(7);
        expect(m.runtime.hosts.get('p1')).toBeUndefined();
    });

    it('writes an entity record under the FULL packed local id', () => {
        const m = mirror();
        const delta = m.applyState(
            stateEnvelope([{ kind: 'spawn', snapshot: entity(1) }], {
                state: [{ host: { kind: 'entity', netId: 1 as NetId }, fields: { hp: 3 } }],
            }),
        );
        const local = delta.added[0]! as number;
        expect(m.runtime.hosts.get(`entity:${local}`)?.record.values.get('hp')).toBe(3);
    });

    it('marks nothing when writing the record', () => {
        const m = mirror();
        m.applyState(stateEnvelope([], { state: [{ host: { kind: 'game' }, fields: { x: 1 } }] }));
        expect(m.runtime.channels.stateCount).toBe(0);
    });
});

describe('applying discards marks but not the render queue', () => {
    it('leaves structuralCount and stateCount at zero while the dirty set is NON-EMPTY', () => {
        const m = mirror();
        m.applyState(
            stateEnvelope([{ kind: 'spawn', snapshot: entity(1, 'thing', { tags: ['a'] }) }], {
                state: [{ host: { kind: 'game' }, fields: { x: 1 } }],
            }),
        );
        expect(m.runtime.channels.structuralCount).toBe(0);
        expect(m.runtime.channels.stateCount).toBe(0);
        // The second half pins that `clear()` does not reach the bitset: a core change moving the
        // transform channel into ReplicationChannels fails HERE.
        expect(m.runtime.transforms.consumeDirty()).not.toHaveLength(0);
    });

    it('does not grow the journal over many apply cycles', () => {
        const m = mirror();
        for (let i = 1; i <= 200; i++) {
            m.applyState(
                stateEnvelope([
                    { kind: 'spawn', snapshot: entity(i) },
                    { kind: 'tag', netId: i as NetId, tag: 't', added: true },
                    { kind: 'destroy', netId: i as NetId },
                ]),
            );
        }
        expect(m.runtime.channels.structuralCount).toBe(0);
    });

    it('coalesces the dirty set: two writes on one entity produce one entry', () => {
        const m = mirror();
        const delta = m.applyState(stateEnvelope([{ kind: 'spawn', snapshot: entity(1) }]));
        m.runtime.transforms.consumeDirty();
        m.applyTransforms({
            kind: 'transform',
            tick: 1,
            transform: [transformDiff(1, { posX: 1 })],
        });
        m.applyTransforms({
            kind: 'transform',
            tick: 1,
            transform: [transformDiff(1, { posX: 2 })],
        });
        expect(m.runtime.transforms.consumeDirty()).toHaveLength(1);
        expect(m.runtime.transforms.posX(delta.added[0]!)).toBe(2);
    });
});

describe('the depicted tick', () => {
    it('is the applied envelope’s tick, set rather than incremented', () => {
        const m = mirror();
        m.applyState(stateEnvelope([], { tick: 500 }));
        expect(m.depictedTick).toBe(500);
        m.applyState(stateEnvelope([], { tick: 501 }));
        expect(m.depictedTick).toBe(501);
    });
});

describe('the snapshot is a delta through the same path', () => {
    it('applies players then entities, and resyncs a NON-EMPTY mirror', () => {
        const m = mirror();
        m.applyState(stateEnvelope([{ kind: 'spawn', snapshot: entity(1, 'stale') }]));
        expect(m.index.size).toBe(1);

        const reset = m.reset();
        expect(reset.removed).toHaveLength(1);
        expect(m.index.size).toBe(0);

        const delta = m.applySnapshot({
            kind: 'welcome',
            protocolVersion: 1,
            yourPlayerId: 'p1',
            yourPlayerIndex: 0,
            simRate: 60,
            sendRate: 20,
            bounds: BOUNDS,
            regions: [],
            clientSentMs: 0,
            serverSentMs: 0,
            snapshot: {
                tick: 300,
                entities: [entity(10, 'fresh'), entity(11, 'child', { parent: 10 as NetId })],
                players: [{ id: 'p1', index: 0, name: 'One' }],
                state: [{ host: { kind: 'game' }, fields: { x: 5 } }],
            },
            visuals: { assets: [], templates: [] },
        });

        expect(delta.added).toHaveLength(2);
        expect(delta.joined).toHaveLength(1);
        expect(m.depictedTick).toBe(300);
        expect(m.counters.outOfOrderParent).toBe(0);
        expect(m.runtime.hosts.ensure('game').record.values.get('x')).toBe(5);
        // No orphaned map entry from the world it replaced.
        expect(m.index.size).toBe(2);
    });
});

describe('nothing writes the mirror outside apply', () => {
    it('changes nothing when no envelope arrives', () => {
        const m = mirror();
        const delta = m.applyState(
            stateEnvelope([
                {
                    kind: 'spawn',
                    snapshot: entity(1, 'thing', { transform: wireTransform({ posX: 9 }) }),
                },
            ]),
        );
        const local = delta.added[0]!;
        const before = m.runtime.transforms.posX(local);
        m.runtime.transforms.consumeDirty();

        // A "frame" with no envelope: nothing is called, so nothing moves and no work is queued.
        expect(m.runtime.transforms.posX(local)).toBe(before);
        expect(m.runtime.transforms.consumeDirty()).toHaveLength(0);
    });

    it('equals the accumulated diffs exactly after N envelopes', () => {
        const m = mirror();
        m.applyState(stateEnvelope([{ kind: 'spawn', snapshot: entity(1) }]));
        const local = m.index.local(1 as NetId)!;
        let expected = 0;
        for (let tick = 2; tick <= 50; tick++) {
            expected = tick * 3;
            m.applyState(stateEnvelope([], { tick }));
            m.applyTransforms({
                kind: 'transform',
                tick,
                transform: [transformDiff(1, { posX: expected })],
            });
        }
        expect(m.runtime.transforms.posX(local)).toBe(expected);
    });

    it('exposes a read-only view that carries no writer', () => {
        const m = mirror();
        const view = m.view();
        expect(Object.keys(view).toSorted()).toEqual(
            ['depictedTick', 'entityFor', 'entries', 'netFor', 'runtime', 'templateOf'].toSorted(),
        );
        m.applyState(stateEnvelope([], { tick: 12 }));
        expect(view.depictedTick).toBe(12);
    });
});
