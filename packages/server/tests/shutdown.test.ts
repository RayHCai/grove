// What a shutdown owes: every online player's save, and nothing durable for a peer nobody named.

import { afterEach, describe, expect, it } from 'vitest';
import type { KVStore } from '@platform/core';
import { MemoryKVStore, PERSISTENCE_SCOPE, clearRuntime, playerKey } from '@platform/core';
import { Accounts, Wallet } from '../dist/testkit/fixtures.js';
import type { GameServer } from '../src/server.js';
import { harness } from './harness.js';

afterEach(() => clearRuntime());

function walletOf(server: GameServer, id: string): Wallet {
    return [...server.runtime.instances.forHost(playerKey(id))]
        .map((si) => si.instance)
        .find((i): i is Wallet => i instanceof Wallet)!;
}

/** A store whose writes land a turn late, which is what every real one does. */
function deferredStore(backing: KVStore): KVStore {
    return {
        get: (scope, key) => backing.get(scope, key),
        set: (scope, key, value) =>
            new Promise((resolve) => {
                setTimeout(() => void backing.set(scope, key, value).then(resolve), 0);
            }),
        delete: (scope, key) => backing.delete(scope, key),
    };
}

describe('close() drains the saves it starts', () => {
    it('settles only once an online player’s state has reached the store', async () => {
        const backing = new MemoryKVStore();
        const h = harness({ config: { gameScripts: [Accounts], kv: deferredStore(backing) } });
        await h.joinedAs('alice');
        walletOf(h.server, 'alice').credits = 42;
        h.pumpTicks(2);

        await h.server.close();

        // Every deploy and every container eviction runs this path, so a save still in flight at
        // exit is silent, total loss for every player who was online.
        expect(await backing.get(PERSISTENCE_SCOPE, playerKey('alice'))).toMatchObject({
            credits: 42,
        });
    });

    it('releases the drain when the store rejects, rather than hanging the shutdown', async () => {
        const kv: KVStore = {
            get: () => Promise.resolve(undefined),
            set: () => Promise.reject(new Error('store unreachable')),
            delete: () => Promise.resolve(),
        };
        const h = harness({ config: { gameScripts: [Accounts], kv } });
        await h.joinedAs('alice');
        h.pumpTicks(2);

        await expect(h.server.close()).resolves.toBeUndefined();
    });

    it('is idempotent, and a second caller waits on the first call’s drain', async () => {
        const backing = new MemoryKVStore();
        const h = harness({ config: { gameScripts: [Accounts], kv: deferredStore(backing) } });
        await h.joinedAs('alice');
        walletOf(h.server, 'alice').credits = 7;
        h.pumpTicks(2);

        void h.server.close();
        await h.server.close();
        expect(await backing.get(PERSISTENCE_SCOPE, playerKey('alice'))).toMatchObject({
            credits: 7,
        });
    });

    it('writes nothing durable for a connection the host never named', async () => {
        const kv = new MemoryKVStore();
        const h = harness({ config: { gameScripts: [Accounts], kv } });
        const peer = h.joined('anon');
        walletOf(h.server, 'c1').credits = 3;
        h.pumpTicks(2);
        peer.close();
        h.pumpTicks(2);
        await h.server.close();

        // A connection id is minted per socket, so a record under one is unreadable by anybody —
        // one leaked KV entry per join/leave cycle, forever.
        expect(await kv.get(PERSISTENCE_SCOPE, playerKey('c1'))).toBeUndefined();
    });
});
