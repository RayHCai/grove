// `@serverState` that outlives a session: the synchronous cache, the write-through, and the seed
// wiring reads. Fixtures are compiled by the build; this file carries no decorator syntax.

import { describe, it, expect, afterEach } from 'vitest';
import { PERSISTENCE_SCOPE, PersistedState } from '../src/runtime/persistence.js';
import { MemoryKVStore } from '../src/runtime/seams.js';
import { Scoreboard, Team } from '../src/runtime/wrappers.js';
import { createHostRecord } from '../src/state/host-record.js';
import { clearRuntime, createRuntime } from '../src/runtime/runtime.js';
import type { Wired } from '../src/runtime/runtime.js';
import type { Player } from '../src/runtime/player.js';

const player = (id: string) => ({ id, name: id }) as unknown as Player;

function withPlayerLookup(): void {
    const rt = createRuntime();
    rt.install({ playerManager: { byId: (id: string) => player(id) } } as unknown as Wired);
}

afterEach(() => {
    clearRuntime();
});

describe('PersistedState', () => {
    it('captures synchronously, so a value is readable before the store write lands', () => {
        const store = new PersistedState(new MemoryKVStore());
        const record = createHostRecord('player:a');
        record.values.set('credits', 10);

        // Not awaited: the boundary that triggers a save is a socket that has already closed, so a
        // capture that only happened once the promise ran would be reading a torn-down record.
        void store.save(record);
        expect(store.get('player:a', 'credits')).toBe(10);
    });

    it('writes a host through as one entry, and reads it back into the cache', async () => {
        const kv = new MemoryKVStore();
        const record = createHostRecord('player:a');
        record.values.set('credits', 10);
        record.values.set('name', 'Ray');
        await new PersistedState(kv).save(record);

        // One KV entry per host, not one per field: a rejoin costs one round trip.
        expect(await kv.get(PERSISTENCE_SCOPE, 'player:a')).toEqual({
            credits: 10,
            name: 'Ray',
        });

        const fresh = new PersistedState(kv);
        expect(fresh.get('player:a', 'credits')).toBeUndefined();
        await fresh.load('player:a');
        expect(fresh.get('player:a', 'credits')).toBe(10);
    });

    it('persists a wrapper as its wire form, never as the class', async () => {
        withPlayerLookup();
        const kv = new MemoryKVStore();
        const record = createHostRecord('game');
        const board = new Scoreboard();
        board.bind(record, 'scores');
        record.values.set('scores', board);
        board.add(5, player('x'));

        await new PersistedState(kv).save(record);
        expect(await kv.get(PERSISTENCE_SCOPE, 'game')).toEqual({
            scores: { kind: 'Scoreboard', scores: [['x', 5]] },
        });
    });

    it('caches a host that has nothing stored, so a second load does not re-ask', async () => {
        const store = new PersistedState(new MemoryKVStore());
        expect(store.has('player:ghost')).toBe(false);
        await store.load('player:ghost');
        expect(store.has('player:ghost')).toBe(true);
        expect(store.get('player:ghost', 'anything')).toBeUndefined();
    });

    it('forgets a host from both the cache and the store', async () => {
        const kv = new MemoryKVStore();
        const store = new PersistedState(kv);
        const record = createHostRecord('player:a');
        record.values.set('credits', 3);
        await store.save(record);

        await store.forget('player:a');
        expect(store.get('player:a', 'credits')).toBeUndefined();
        expect(await kv.get(PERSISTENCE_SCOPE, 'player:a')).toBeUndefined();
    });

    it('treats a stored value that is not a field bag as nothing held', async () => {
        const kv = new MemoryKVStore();
        await kv.set(PERSISTENCE_SCOPE, 'player:a', 'not a record');
        const store = new PersistedState(kv);
        await store.load('player:a');
        expect(store.get('player:a', 'credits')).toBeUndefined();
    });
});

describe('a wrapper is seeded from persistence at bind time', () => {
    it('restores a previous session’s contents into the initializer’s empty wrapper', () => {
        const rt = createRuntime();
        rt.install({ playerManager: { byId: (id: string) => player(id) } } as unknown as Wired);

        // What the previous session left behind.
        const before = createHostRecord('game');
        const source = new Team('red');
        source.bind(before, 'red');
        source.add(player('x'));
        const store = new PersistedState(new MemoryKVStore());
        before.values.set('red', source);
        void store.save(before);
        rt.persisted = store;

        // What this session's field initializer built: an empty one, bound through wiring.
        const record = rt.hosts.ensure('game').record;
        const fresh = new Team('red');
        fresh.bind(record, 'red');
        const persisted = rt.persisted.get('game', 'red');
        expect(persisted).toBeDefined();
        fresh.restore(persisted);
        expect(fresh.players.map((p) => p.id)).toEqual(['x']);
    });
});
