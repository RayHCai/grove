// Three maps keyed by something a departing player takes with them — the persisted-record cache, the
// roster's checkpoints and the breaker's counters. Each is written on a join or a leave and read
// only while that player is present, so any of them left unpruned sizes a long-running server by the
// players it has ever seen rather than by the ones it is serving.

import { describe, it, expect, afterEach } from 'vitest';
import { joinPlayer, leavePlayer, loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import { PersistedState } from '../src/runtime/persistence.js';
import { MemoryKVStore } from '../src/runtime/seams.js';
import { createHostRecord } from '../src/state/host-record.js';
import { playerKey } from '../src/runtime/hosts.js';
import type { ScriptInstance } from '../src/dispatch/instances.js';

afterEach(() => clearRuntime());

/** Stands in for a script class; the dispatcher only ever reads its identity. */
class ProbeClass {
    readonly kind = 'probe';
}

describe('the persisted-record cache', () => {
    it('releases a host once its write has landed, and the store still has it', async () => {
        const kv = new MemoryKVStore();
        const store = new PersistedState(kv);

        for (let i = 0; i < 50; i++) {
            const record = createHostRecord(playerKey(`p${i}`));
            record.values.set('credits', i);
            await store.save(record);
            expect(store.has(playerKey(`p${i}`))).toBe(false);
        }

        // Released, never dropped: a rejoin costs the one round trip the leave already paid for.
        await store.load(playerKey('p7'));
        expect(store.get(playerKey('p7'), 'credits')).toBe(7);
    });
});

describe('the roster’s checkpoints', () => {
    it('go with the player, so a reused id does not spawn where a stranger died', () => {
        const rt = loadGame();
        const first = joinPlayer(rt, 'p1', 'P');
        first.spawn();
        rt.wired.roster.setCheckpoint(first, 40, 40);
        leavePlayer(rt, 'p1');

        const second = joinPlayer(rt, 'p1', 'Q');
        second.spawn();
        expect(second.avatar.position.x).toBe(0);
        expect(second.avatar.position.y).toBe(0);
    });
});

describe('the breaker’s counters', () => {
    it('go with the instance, which a host removal is the end of', () => {
        const rt = loadGame();
        const player = joinPlayer(rt, 'p1', 'P');
        const hostKey = playerKey(player.id);
        const si: ScriptInstance = {
            id: 77_001,
            instance: {},
            klass: ProbeClass,
            className: 'Probe',
            location: 'server',
            handlers: [],
            hostScopeId: rt.hosts.ensure(hostKey).scopeId,
        };
        rt.instances.attach(hostKey, si);

        rt.dispatcher.guard(si, { method: 'go', hostId: hostKey, tick: 0, event: '@probe' }, () => {
            throw new Error('probe always throws');
        });
        expect(rt.breaker.count(si.id, 'go')).toBe(1);

        leavePlayer(rt, 'p1');
        // A streak that never ended in a success is what leaves an entry, and the instance it names
        // no longer exists — ids are never reused, so nothing would ever clear it.
        expect(rt.breaker.count(si.id, 'go')).toBe(0);
    });
});
