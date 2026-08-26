// `@serverState` across a rejoin: the host names the peer, the record is read under that name
// before the join handlers run, and the leave writes it back.

import { afterEach, describe, expect, it } from 'vitest';
import type { KVStore } from '@platform/core';
import { MemoryKVStore, PERSISTENCE_SCOPE, clearRuntime, playerKey } from '@platform/core';
import type { GameServer } from '../src/server.js';
import { Accounts, Squad, Wallet } from '../dist/testkit/fixtures.js';
import { Harness, harness } from './harness.js';

afterEach(() => clearRuntime());

function walletOf(server: GameServer, id: string): Wallet {
    return [...server.runtime.instances.forHost(playerKey(id))]
        .map((si) => si.instance)
        .find((i): i is Wallet => i instanceof Wallet)!;
}

function squadOf(server: GameServer, id: string): Squad {
    return [...server.runtime.instances.forHost(playerKey(id))]
        .map((si) => si.instance)
        .find((i): i is Squad => i instanceof Squad)!;
}

describe('a host-named player rejoins into what the last session saved', () => {
    it('seeds both plain and wrapper state from the store', async () => {
        const kv = new MemoryKVStore();
        const h = harness({ config: { gameScripts: [Accounts], kv } });

        const first = await h.joinedAs('alice');
        expect(first.welcome?.yourPlayerId).toBe('alice');
        walletOf(h.server, 'alice').credits = 42;
        squadOf(h.server, 'alice').team.add(h.server.runtime.playerManager!.byId('alice')!);
        h.pumpTicks(4);
        first.close();
        h.pumpTicks(2);
        await new Promise((resolve) => setTimeout(resolve, 0));

        await h.joinedAs('alice');
        expect(walletOf(h.server, 'alice').credits).toBe(42);
        // Only passes because the id is stable: a Team serializes its members BY id.
        const rejoined = h.server.runtime.playerManager!.byId('alice')!;
        expect(squadOf(h.server, 'alice').team.has(rejoined)).toBe(true);
    });

    it('rehydrates the record in a process that never saw the save', async () => {
        const kv = new MemoryKVStore();
        const first = harness({ config: { gameScripts: [Accounts], kv } });
        const peer = await first.joinedAs('alice');
        walletOf(first.server, 'alice').credits = 7;
        first.pumpTicks(4);
        peer.close();
        first.pumpTicks(2);
        await new Promise((resolve) => setTimeout(resolve, 0));
        // Every read of the first harness happens before the second exists: `createRuntime` replaces
        // core's module-global, and a wrapper's player lookup resolves against the newer one.
        expect(await kv.get(PERSISTENCE_SCOPE, playerKey('alice'))).toMatchObject({ credits: 7 });
        first.server.close();

        const second = harness({ config: { gameScripts: [Accounts], kv } });
        await second.joinedAs('alice');
        expect(walletOf(second.server, 'alice').credits).toBe(7);
    });

    it('refuses a second live connection claiming one identity', async () => {
        const h = harness({ config: { gameScripts: [Accounts], kv: new MemoryKVStore() } });
        await h.joinedAs('alice');
        const second = await h.joinedAs('alice');
        expect(second.reject?.reason).toBe('full');
        expect(h.server.runtime.playerManager!.players).toHaveLength(1);
    });

    it('leaves an unidentified connection on its per-connection id, as before', () => {
        const h = harness({ config: { gameScripts: [Accounts], kv: new MemoryKVStore() } });
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
        const h = new Harness({ config: { gameScripts: [Accounts], kv } });

        const peer = await h.joinedAs('alice');
        expect(peer.welcome).toBeDefined();
        // Wallet's own initializer, because nothing seeded it.
        expect(walletOf(h.server, 'alice').credits).toBe(10);

        peer.close();
        h.pumpTicks(2);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(await backing.get(PERSISTENCE_SCOPE, playerKey('alice'))).toStrictEqual({
            credits: 99,
        });
    });
});
