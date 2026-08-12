// The drain and the fan-out (DESIGN §5, §8). Fixtures are compiled by the build.

import { afterEach, describe, expect, it } from 'vitest';
import { GAME_KEY, clearRuntime } from '@platform/core';
import type { WireStructuralOp } from '@platform/protocol';
import { Health, Rules, Wallet } from '../dist/testkit/fixtures.js';
import { CountingCodec, harness } from './harness.js';
import type { Peer } from './harness.js';

afterEach(() => {
    clearRuntime();
});

function ops(peer: Peer): WireStructuralOp[] {
    return peer.states.flatMap((s) => s.structural);
}

describe('§5.2 — every envelope is tick-stamped, and the pair is joined by tick', () => {
    it('carries the step tick, the per-connection ack, and a matching transform envelope', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        h.settle([peer]);
        h.pumpTicks(6);

        const state = peer.lastState;
        expect(state?.tick).toBeGreaterThan(0);
        expect(state?.ackSeq).toBe(-1);
        // The join key is an EQUALITY: the client holds a transform envelope until the state
        // envelope for its tick has been applied (protocol §3.3.2).
        const paired = peer.transforms.find((t) => t.tick === state?.tick);
        expect(paired).toBeDefined();
    });

    it('sends the reliable envelope on a quiet tick, with both arrays empty', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        h.settle([peer]);
        h.pumpTicks(8);

        // A wire rule rather than an optimization: §3.3.2 holds a transform envelope until the
        // state envelope for its tick has been applied, so suppressing the empty ones would leave
        // every transform envelope in a quiet tick with no counterpart and nothing moving.
        const quiet = peer.states.filter((s) => s.structural.length === 0 && s.state.length === 0);
        expect(quiet.length).toBeGreaterThan(0);
    });

    it('gives two connections their own acks', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const busy = h.joined('a');
        const idle = h.joined('b');
        h.settle([busy, idle]);
        busy.input(h.tick + 2, [{ action: 'jump', on: 'press' }]);
        h.pumpTicks(8);

        expect(busy.lastState?.ackSeq).toBe(0);
        expect(idle.lastState?.ackSeq).toBe(-1);
    });
});

describe('§5.3 — the drain runs once and the broadcast fans it out', () => {
    it('a single spawn appears in EVERY connection’s envelope', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const one = h.joined('a');
        const two = h.joined('b');
        const three = h.joined('c');
        h.settle([one, two, three]);

        h.server.runtime.entityManager.spawn('crate', 1, 2);
        h.pumpTicks(6);

        // A per-connection drain would let the first connection take the marks and leave the rest
        // with nothing — this is the assertion that catches it.
        for (const p of [one, two, three]) {
            expect(ops(p).filter((o) => o.kind === 'spawn')).toHaveLength(1);
        }
    });

    it('accumulates between send-ticks: three moves become one diff at the final position', () => {
        const h = harness({ config: { gameScripts: [Rules], sendRate: 20 } });
        const peer = h.joined('a');
        const crate = h.server.runtime.entityManager.spawn('crate', 0, 0);
        h.settle([peer]);

        // Aligned, so all three moves and the send that carries them fall in ONE interval: the
        // channels accumulate until drained, and that accumulation IS the net change.
        h.alignToSend();
        peer.clear();
        crate.setPosition(1, 0);
        h.pumpTicks(1);
        crate.setPosition(2, 0);
        h.pumpTicks(1);
        crate.setPosition(3, 0);
        h.pumpTicks(1);
        h.pumpTicks(2);

        const diffs = peer.transforms
            .flatMap((t) => t.transform)
            .filter((d) => d.netId === (crate.entityId as unknown as number));
        expect(diffs).toHaveLength(1);
        expect(diffs[0]?.posX).toBe(3);
    });

    it('carries the whole transform, eight keys, in core’s field order', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const crate = h.server.runtime.entityManager.spawn('crate', 5, 6);
        crate.layer = 2;
        crate.setScale(3);
        peer.clear();
        h.pumpTicks(6);

        const diff = peer.transforms.flatMap((t) => t.transform)[0];
        expect(Object.keys(diff ?? {})).toStrictEqual([
            'posX',
            'posY',
            'posZ',
            'rot',
            'scale',
            'opacity',
            'layer',
            'netId',
        ]);
        expect(Number.isInteger(diff?.layer)).toBe(true);
    });

    it('a spawn carries a full snapshot with no hierarchy, since parenting arrives as its own op', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const rt = h.server.runtime;
        peer.clear();

        const parent = rt.entityManager.spawn('parent', 0, 0);
        const child = rt.entityManager.spawn('child', 4, 4);
        child.tag('shiny');
        child.attachTo(parent);
        h.pumpTicks(6);

        const journal = ops(peer);
        const spawn = journal.find((o) => o.kind === 'spawn' && o.snapshot.template === 'child');
        expect(spawn).toMatchObject({ kind: 'spawn' });
        if (spawn?.kind === 'spawn') {
            // At the moment of a spawn core's `create` has set no parent and no tags; both arrive
            // later in this same journal, already in the right position.
            expect(spawn.snapshot.parent).toBeNull();
            expect(spawn.snapshot.tags).toStrictEqual([]);
            expect(spawn.snapshot.transform.posX).toBe(4);
        }
        // Order is meaning, so the ops that got it there follow the spawn.
        const kinds = journal.map((o) => o.kind);
        expect(kinds.indexOf('tag')).toBeGreaterThan(kinds.indexOf('spawn'));
        expect(kinds).toContain('reparent');
    });

    it('detach reaches the wire as reparent { parent: null }', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const rt = h.server.runtime;
        const parent = rt.entityManager.spawn('parent', 0, 0);
        const child = rt.entityManager.spawn('child', 0, 0);
        child.attachTo(parent);
        h.pumpTicks(6);
        peer.clear();

        child.detach();
        h.pumpTicks(6);

        const reparents = ops(peer).filter((o) => o.kind === 'reparent');
        expect(reparents).toHaveLength(1);
        expect(reparents[0]).toMatchObject({ parent: null });
    });

    it('filters the say: pseudo-tag and keeps a real one', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const crate = h.server.runtime.entityManager.spawn('crate', 0, 0);
        h.pumpTicks(6);
        peer.clear();

        crate.say('hello');
        crate.tag('solid');
        h.pumpTicks(6);

        const tags = ops(peer).filter((o) => o.kind === 'tag');
        expect(tags).toHaveLength(1);
        expect(tags[0]).toMatchObject({ tag: 'solid', added: true });
    });

    it('drops a spawn-then-destroy pair rather than shipping an unreadable snapshot', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        peer.clear();

        const doomed = h.server.runtime.entityManager.spawn('ghost', 0, 0);
        const netId = doomed.entityId as unknown as number;
        doomed.destroy();
        h.pumpTicks(6);

        // `spawn` carries a full EntitySnapshot, and a released entity has no record to read one
        // from — its template would go out as '', which the client rejects, aborting the whole
        // reconcile. An entity that lived less than one send interval is gone either way.
        const journal = ops(peer);
        expect(journal.some((o) => o.kind === 'spawn' && o.snapshot.netId === netId)).toBe(false);
        expect(journal.some((o) => o.kind === 'destroy' && o.netId === netId)).toBe(false);
    });

    it('emits a destroy for an entity the client already knew about', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const crate = h.server.runtime.entityManager.spawn('crate', 0, 0);
        const netId = crate.entityId as unknown as number;
        h.pumpTicks(6);
        peer.clear();

        crate.destroy();
        h.pumpTicks(6);
        expect(ops(peer).some((o) => o.kind === 'destroy' && o.netId === netId)).toBe(true);
    });
});

describe('§5.3 — state is addressed by host and scoped per player', () => {
    it('sends game state to everyone and player state only to its owner', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const one = h.joined('a');
        const two = h.joined('b');
        const rt = h.server.runtime;
        const first = rt.playerManager?.byId('c1');
        first?.addScript(Wallet as never);
        h.pumpTicks(6);
        one.clear();
        two.clear();

        (first as unknown as { credits: number }).credits = 99;
        const rules = [...rt.instances.forHost('game')][0]?.instance as Rules;
        rules.round = 7;
        h.pumpTicks(6);

        const mine = one.states.flatMap((s) => s.state);
        const theirs = two.states.flatMap((s) => s.state);
        expect(mine.some((d) => d.host.kind === 'player' && 'credits' in d.fields)).toBe(true);
        expect(theirs.some((d) => 'credits' in d.fields)).toBe(false);
        for (const side of [mine, theirs]) {
            expect(side.some((d) => d.host.kind === 'game' && 'round' in d.fields)).toBe(true);
        }
    });

    it('addresses an entity host by netId', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const crate = h.server.runtime.entityManager.spawn('crate', 0, 0);
        crate.addScript(Health as never);
        h.pumpTicks(6);
        peer.clear();

        const host = `entity:${crate.entityId as unknown as number}`;
        const health = [...h.server.runtime.instances.forHost(host)][0]?.instance as Health;
        health.health = 1;
        h.pumpTicks(6);

        const diff = peer.states.flatMap((s) => s.state).find((d) => 'health' in d.fields);
        expect(diff?.host).toStrictEqual({
            kind: 'entity',
            netId: crate.entityId as unknown as number,
        });
        expect(diff?.fields['health']).toBe(1);
    });

    it('groups one host\u2019s fields under a single address', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const rt = h.server.runtime;
        h.pumpTicks(6);
        peer.clear();

        // Two fields on the same host in one send interval share one entry, and the address that
        // used to be repeated per field appears once.
        const record = rt.hosts.ensure(GAME_KEY).record;
        record.values.set('round', 7);
        record.values.set('phase', 'dusk');
        rt.channels.markState(record, 'round');
        rt.channels.markState(record, 'phase');
        h.pumpTicks(6);

        const game = peer.states.flatMap((s) => s.state).filter((d) => d.host.kind === 'game');
        expect(game).toHaveLength(1);
        expect(game[0]?.fields).toStrictEqual({ round: 7, phase: 'dusk' });
    });

    it('drops and counts a reserved field name rather than aborting the send', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const rt = h.server.runtime;
        h.pumpTicks(6);
        peer.clear();

        // A field name the codec refuses as a key. Assigning it would set the bucket's prototype
        // instead of adding a key, so it is dropped at the boundary and the rest of the send lands.
        const record = rt.hosts.ensure(GAME_KEY).record;
        record.values.set('__proto__', 'polluted');
        record.values.set('round', 3);
        rt.channels.markState(record, '__proto__');
        rt.channels.markState(record, 'round');
        h.pumpTicks(6);

        const game = peer.states.flatMap((s) => s.state).find((d) => d.host.kind === 'game');
        expect(game?.fields).toStrictEqual({ round: 3 });
        // An own key, not a mutated prototype — which is what assigning the name would have done.
        expect(Object.getPrototypeOf(game?.fields)).toBe(Object.prototype);
    });

    it('encodes a @serverState field holding an Entity as a numeric netId', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const peer = h.joined('a');
        const rt = h.server.runtime;
        const crate = rt.entityManager.spawn('crate', 0, 0);
        const rules = [...rt.instances.forHost('game')][0]?.instance as Rules;
        h.pumpTicks(6);
        peer.clear();

        // `@serverState` may hold an Entity, and the host record holds it raw — jsonCodec rejects a
        // class instance, so a ref travels as what identifies it across the wire.
        (rules as unknown as { round: unknown }).round = crate;
        h.pumpTicks(6);

        const diff = peer.states.flatMap((s) => s.state).find((d) => 'round' in d.fields);
        expect(diff?.fields['round']).toBe(crate.entityId as unknown as number);
    });
});

describe('§5.3 — roster ops the journal has no arm for', () => {
    it('tells existing peers about a join and a leave, in that order', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const first = h.joined('a');
        h.settle([first]);

        const second = h.joined('b');
        h.pumpTicks(6);
        const joins = ops(first).filter((o) => o.kind === 'player-join');
        expect(joins).toHaveLength(1);
        expect(joins[0]).toMatchObject({ player: { id: 'c2', index: 1 } });

        first.clear();
        second.close();
        h.pumpTicks(6);

        const journal = ops(first);
        const leaveAt = journal.findIndex((o) => o.kind === 'player-leave');
        expect(leaveAt).toBeGreaterThanOrEqual(0);
        // player-leave must FOLLOW the destroys of that player's owned entities: leave-first hands
        // @onPlayerLeave a world where entity.owner is already null for the avatar it names.
        const destroyAt = journal.findIndex((o) => o.kind === 'destroy');
        expect(destroyAt).toBeGreaterThanOrEqual(0);
        expect(destroyAt).toBeLessThan(leaveAt);
    });
});

describe('§5.4 — the fan-out', () => {
    it('encodes the shared transform envelope once and sendEncoded per connection', () => {
        const codec = new CountingCodec();
        const h = harness({ config: { gameScripts: [Rules] }, codec });
        const peers = [h.joined('a'), h.joined('b'), h.joined('c')];
        expect(peers).toHaveLength(3);

        const before = codec.encodes;
        h.pumpTicks(3); // exactly one send-tick at 60/20
        // One encode for the whole broadcast, whatever the connection count — the shrinking residue
        // §5.4 warns encode-once is, which after the envelope split is the transform envelope.
        expect(codec.encodes - before).toBe(1);
    });

    it('a peer dropping between step and send does not abort the fan-out', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const doomed = h.joined('a');
        const survivor = h.joined('b');
        survivor.clear();

        doomed.close();
        expect(() => h.pumpTicks(6)).not.toThrow();
        expect(survivor.states.length).toBeGreaterThan(0);
    });

    it('skips a connection that has not joined', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        h.joined('a');
        const lurker = h.connect();
        h.pumpTicks(6);
        expect(lurker.received).toStrictEqual([]);
    });
});

describe('§3.3 — a joiner is not told twice about what its snapshot already holds', () => {
    it('receives no structural op that predates its own snapshot', () => {
        const h = harness({ config: { gameScripts: [Rules] } });
        const first = h.joined('a');
        h.settle([first]);

        // Spawned mid-interval, so the op is still undrained when the second peer joins.
        h.alignToSend();
        const crate = h.server.runtime.entityManager.spawn('crate', 3, 4);
        const netId = crate.entityId as unknown as number;
        h.pumpTicks(1);

        const second = h.joined('b');
        const snapshot = second.welcome?.snapshot;
        expect(snapshot?.entities.some((e) => e.netId === netId)).toBe(true);

        h.pumpTicks(8);
        // Applying a spawn for an entity the snapshot already seeded would mint a SECOND local
        // entity and overwrite the netId mapping, orphaning the first.
        expect(ops(second).some((o) => o.kind === 'spawn' && o.snapshot.netId === netId)).toBe(
            false,
        );
    });
});
