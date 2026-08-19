// The data wrappers: bind identity, marking, persistence round-trip,
// and the bind-twice load-time error.

import { describe, it, expect, afterEach } from 'vitest';
import { Scoreboard, Leaderboard, Inventory, Team } from '../src/runtime/wrappers.js';
import { createHostRecord } from '../src/state/host-record.js';
import { createRuntime, clearRuntime } from '../src/runtime/runtime.js';
import type { Player } from '../src/runtime/player.js';
import type { PlayerManager } from '../src/runtime/player.js';

// A minimal Player stand-in — the wrappers key by `.id` only.
const player = (id: string) => ({ id, name: id }) as unknown as Player;

// top()/players() resolve ids through the current runtime, so a lookup needs one to live on.
function withPlayerLookup(): void {
    const rt = createRuntime();
    rt.playerManager = { byId: (id: string) => player(id) } as unknown as PlayerManager;
}

afterEach(() => {
    clearRuntime();
});

describe('StatefulWrapper.bind', () => {
    it('throws when the same instance is bound twice', () => {
        const s = new Scoreboard();
        const r1 = createHostRecord('game');
        const r2 = createHostRecord('player:1');
        s.bind(r1, 'scores');
        expect(() => s.bind(r2, 'scores')).toThrow(/already bound/);
    });

    it('throws on use before assignment to a field', () => {
        const s = new Scoreboard();
        expect(() => s.add(1, player('p1'))).toThrow(/before assignment/);
    });

    it('marks the host record on a mutating call', () => {
        const s = new Scoreboard();
        const record = createHostRecord('game');
        const marks: string[] = [];
        record.markDirty = (field) => marks.push(field);
        s.bind(record, 'scores');
        s.add(5, player('p1'));
        expect(marks).toEqual(['scores']);
    });
});

describe('wrapper behavior', () => {
    it('Scoreboard tracks and ranks', () => {
        withPlayerLookup();
        const s = new Scoreboard();
        s.bind(createHostRecord('game'), 'scores');
        s.add(3, player('a'));
        s.add(5, player('b'));
        s.add(1, player('c'));
        expect(s.of(player('b'))).toBe(5);
        expect(s.top(2).map((p) => p.id)).toEqual(['b', 'a']);
    });

    it('Leaderboard keeps the best and ranks', () => {
        withPlayerLookup();
        const lb = new Leaderboard({ order: 'high' });
        lb.bind(createHostRecord('game'), 'wins');
        lb.submit(10, player('a'));
        lb.submit(5, player('a')); // worse — ignored
        lb.submit(20, player('b'));
        expect(lb.of(player('a'))).toBe(10);
        expect(lb.rankOf(player('b'))).toBe(1);
    });

    it('Inventory counts and clears', () => {
        const inv = new Inventory(player('a'));
        inv.bind(createHostRecord('player:a'), 'bag');
        inv.add('sword');
        inv.add('coin', 5);
        expect(inv.count('coin')).toBe(5);
        expect(inv.has('sword')).toBe(true);
        inv.remove('coin', 5);
        expect(inv.has('coin')).toBe(false);
    });

    it('Team membership', () => {
        withPlayerLookup();
        const t = new Team('red');
        t.bind(createHostRecord('game'), 'red');
        t.add(player('a'));
        expect(t.has(player('a'))).toBe(true);
        expect(t.players.map((p) => p.id)).toEqual(['a']);
    });

    it('serialize / restore round-trips a Scoreboard', () => {
        withPlayerLookup();
        const a = new Scoreboard();
        a.bind(createHostRecord('game'), 'scores');
        a.add(7, player('x'));
        const wire = a.serialize();

        const b = new Scoreboard();
        b.bind(createHostRecord('game'), 'scores');
        b.restore(wire);
        expect(b.of(player('x'))).toBe(7);
    });

    it('serialize / restore round-trips a Leaderboard, order and all', () => {
        withPlayerLookup();
        const a = new Leaderboard({ order: 'low' });
        a.bind(createHostRecord('game'), 'times');
        a.submit(30, player('x'));
        a.submit(10, player('y'));
        const wire = a.serialize();
        expect(Object.keys(wire as object)).toEqual(['kind', 'order', 'scores']);
        expect(wire).toEqual({
            kind: 'Leaderboard',
            order: 'low',
            scores: [
                ['x', 30],
                ['y', 10],
            ],
        });

        const b = new Leaderboard({ order: 'low' });
        b.bind(createHostRecord('game'), 'times');
        b.restore(wire);
        expect(b.of(player('x'))).toBe(30);
        expect(b.rankOf(player('y'))).toBe(1);
    });

    it('serialize / restore refills a Team that already holds another member', () => {
        withPlayerLookup();
        const a = new Team('red');
        a.bind(createHostRecord('game'), 'red');
        a.add(player('x'));
        const wire = a.serialize();
        expect(Object.keys(wire as object)).toEqual(['kind', 'name', 'members']);
        expect(wire).toEqual({ kind: 'Team', name: 'red', members: ['x'] });

        const b = new Team('red');
        b.bind(createHostRecord('game'), 'red');
        b.add(player('stale'));
        b.restore(wire);
        expect(b.has(player('stale'))).toBe(false);
        expect(b.players.map((p) => p.id)).toEqual(['x']);
    });

    it('Team.restore leaves membership alone when handed another class wire form', () => {
        withPlayerLookup();
        const t = new Team('red');
        t.bind(createHostRecord('game'), 'red');
        t.add(player('a'));
        t.restore(new Scoreboard().serialize());
        expect(t.players.map((p) => p.id)).toEqual(['a']);
    });

    it('restore ignores a wire form from a different wrapper class (tag mismatch)', () => {
        const inv = new Inventory(player('a'));
        inv.bind(createHostRecord('player:a'), 'bag');
        inv.restore(new Scoreboard().serialize()); // wrong class identity
        expect(inv.count('anything')).toBe(0);
    });
});
