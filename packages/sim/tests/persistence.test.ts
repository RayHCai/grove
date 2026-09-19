import { afterEach, describe, expect, it } from 'vitest';
import type { KVStore } from '@platform/core';
import {
    GAME_KEY,
    MemoryKVStore,
    PERSISTENCE_SCOPE,
    clearRuntime,
    playerKey,
} from '@platform/core';
import type { Sim } from '../src/sim.js';
import { Accounts, Era, Squad, Wallet } from '../dist/testkit/fixtures.js';
import { Harness, harness, kvStore } from './harness.js';

afterEach(() => clearRuntime());

function walletOf(sim: Sim, id: string): Wallet {
    return [...sim.runtime.instances.forHost(playerKey(id))]
        .map((si) => si.instance)
        .find((i): i is Wallet => i instanceof Wallet)!;
}

function eraOf(sim: Sim): Era {
    return [...sim.runtime.instances.forHost(GAME_KEY)]
        .map((si) => si.instance)
        .find((i): i is Era => i instanceof Era)!;
}

function squadOf(sim: Sim, id: string): Squad {
    return [...sim.runtime.instances.forHost(playerKey(id))]
        .map((si) => si.instance)
        .find((i): i is Squad => i instanceof Squad)!;
}

describe('a host-named player rejoins into what the last session saved', () => {
    it('seeds both plain and wrapper state from the store', async () => {
        const kv = new MemoryKVStore();
        const h = harness({ config: { gameScripts: [Accounts] }, store: kvStore(kv) });

        const first = await h.joinedAs('alice');
        expect(first.welcome?.yourPlayerId).toBe('alice');
        walletOf(h.sim, 'alice').credits = 42;
        squadOf(h.sim, 'alice').team.add(h.sim.runtime.playerManager!.byId('alice')!);
        h.pumpTicks(4);
        first.close();
        h.pumpTicks(2);
        await new Promise((resolve) => setTimeout(resolve, 0));

        await h.joinedAs('alice');
        expect(walletOf(h.sim, 'alice').credits).toBe(42);
        // Only passes because the id is stable: a Team serializes its members BY id.
        const rejoined = h.sim.runtime.playerManager!.byId('alice')!;
        expect(squadOf(h.sim, 'alice').team.has(rejoined)).toBe(true);
    });

    it('rehydrates the record in a process that never saw the save', async () => {
        const kv = new MemoryKVStore();
        const first = harness({ config: { gameScripts: [Accounts] }, store: kvStore(kv) });
        const peer = await first.joinedAs('alice');
        walletOf(first.sim, 'alice').credits = 7;
        first.pumpTicks(4);
        peer.close();
        first.pumpTicks(2);
        await new Promise((resolve) => setTimeout(resolve, 0));
        // Every read of the first harness happens before the second exists: `createRuntime`
        // replaces core's module-global, and a wrapper's player lookup resolves against the newer
        // one.
        expect(await kv.get(PERSISTENCE_SCOPE, playerKey('alice'))).toMatchObject({ credits: 7 });
        first.close();

        const second = harness({ config: { gameScripts: [Accounts] }, store: kvStore(kv) });
        await second.joinedAs('alice');
        expect(walletOf(second.sim, 'alice').credits).toBe(7);
    });

    it('refuses a second live connection claiming one identity', async () => {
        const h = harness({
            config: { gameScripts: [Accounts] },
            store: kvStore(new MemoryKVStore()),
        });
        await h.joinedAs('alice');
        const second = await h.joinedAs('alice');
        expect(second.reject?.reason).toBe('full');
        expect(h.sim.runtime.playerManager!.players).toHaveLength(1);
    });

    it('leaves an unidentified connection on its per-connection id, as before', () => {
        const h = harness({
            config: { gameScripts: [Accounts] },
            store: kvStore(new MemoryKVStore()),
        });
        const peer = h.joined('anon');
        expect(peer.welcome?.yourPlayerId).toBe('c1');
    });

    it('admits when the store cannot be read, and does not write over what it failed to read', async () => {
        const backing = new MemoryKVStore();
        await backing.set(PERSISTENCE_SCOPE, playerKey('alice'), { credits: 99 });
        const kv: KVStore = {
            get: () => Promise.reject(new Error('store unreachable')),
            set: (scope, key, value) => backing.set(scope, key, value),
            delete: (scope, key) => backing.delete(scope, key),
        };
        const h = new Harness({ config: { gameScripts: [Accounts] }, store: kvStore(kv) });

        const peer = await h.joinedAs('alice');
        expect(peer.welcome).toBeDefined();
        // Wallet's own initializer, because nothing seeded it.
        expect(walletOf(h.sim, 'alice').credits).toBe(10);

        peer.close();
        h.pumpTicks(2);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(await backing.get(PERSISTENCE_SCOPE, playerKey('alice'))).toStrictEqual({
            credits: 99,
        });
    });
});

describe('a game-hosted @serverState is replicated for the session and never checkpointed', () => {
    it('is absent from the record the leave writes, and back at its initializer next session', async () => {
        const kv = new MemoryKVStore();
        const h = harness({ config: { gameScripts: [Accounts, Era] }, store: kvStore(kv) });

        const peer = await h.joinedAs('alice');
        walletOf(h.sim, 'alice').credits = 42;
        eraOf(h.sim).epoch = 9;
        h.pumpTicks(4);
        peer.close();
        h.pumpTicks(2);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(h.saves.map((s) => s.hostKey)).toStrictEqual([playerKey('alice')]);
        expect(Object.keys(h.saves[0]!.fields)).toContain('credits');
        expect(Object.keys(h.saves[0]!.fields)).not.toContain('epoch');
        expect(await kv.get(PERSISTENCE_SCOPE, GAME_KEY)).toBeUndefined();
        h.close();

        const second = harness({ config: { gameScripts: [Accounts, Era] }, store: kvStore(kv) });
        await second.joinedAs('alice');
        expect(walletOf(second.sim, 'alice').credits).toBe(42);
        expect(eraOf(second.sim).epoch).toBe(1);
    });

    it('is never named by a load order either', async () => {
        const kv = new MemoryKVStore();
        const h = harness({ config: { gameScripts: [Accounts, Era] }, store: kvStore(kv) });

        await h.joinedAs('alice');
        h.pumpTicks(4);

        expect(h.loads.map((l) => l.hostKey)).toStrictEqual([playerKey('alice')]);
    });
});
