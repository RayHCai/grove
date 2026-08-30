// The data wrappers: bind identity, marking, persistence round-trip,
// and the bind-twice load-time error.

import { describe, it, expect, afterEach } from 'vitest';
import {
    Scoreboard,
    Leaderboard,
    Inventory,
    Team,
    restoreHostField,
    reviveWrapper,
    serializeHostField,
} from '../src/runtime/wrappers.js';
import { createHostRecord } from '../src/state/host-record.js';
import { createRuntime, clearRuntime } from '../src/runtime/runtime.js';
import type { Wired } from '../src/runtime/runtime.js';
import type { Player } from '../src/runtime/player.js';

// A minimal Player stand-in — the wrappers key by `.id` only.
const player = (id: string) => ({ id, name: id }) as unknown as Player;

// top()/players() resolve ids through the current runtime, so a lookup needs one to live on.
function withPlayerLookup(): void {
    const rt = createRuntime();
    rt.install({ playerManager: { byId: (id: string) => player(id) } } as unknown as Wired);
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

// The two ends both endpoints replicate a wrapper through. Without them the field's value is the
// wrapper OBJECT, which no codec carries — so the mark is raised, the drain finds a class instance,
// and the write is dropped and counted while everything upstream looks like it worked.

describe('serializeHostField', () => {
    it('substitutes a bound wrapper’s wire form and leaves every other field raw', () => {
        withPlayerLookup();
        const record = createHostRecord('game');
        const board = new Scoreboard();
        board.bind(record, 'scores');
        record.values.set('scores', board);
        record.values.set('round', 3);

        expect(serializeHostField(record, 'scores')).toEqual({
            kind: 'Scoreboard',
            scores: [],
        });
        expect(serializeHostField(record, 'round')).toBe(3);
    });
});

describe('restoreHostField', () => {
    it('restores a wrapper the record already holds, rather than replacing it', () => {
        withPlayerLookup();
        const record = createHostRecord('game');
        const held = new Scoreboard();
        held.bind(record, 'scores');
        record.values.set('scores', held);

        const source = new Scoreboard();
        source.bind(createHostRecord('game'), 'scores');
        source.add(7, player('x'));
        restoreHostField(record, 'scores', source.serialize());

        // The same instance: a script may be holding it, and swapping it for the decoded payload
        // would leave that script pointing at a methodless object.
        expect(record.values.get('scores')).toBe(held);
        expect(held.of(player('x'))).toBe(7);
    });

    it('revives a working wrapper when the record holds none — methods and all', () => {
        withPlayerLookup();
        const record = createHostRecord('game');
        const source = new Scoreboard();
        source.bind(createHostRecord('game'), 'scores');
        source.add(4, player('a'));
        source.add(9, player('b'));

        restoreHostField(record, 'scores', source.serialize());

        const revived = record.values.get('scores');
        expect(revived).toBeInstanceOf(Scoreboard);
        // The acceptance the whole change is for: a client running no scripts can still call this.
        expect((revived as Scoreboard).of(player('b'))).toBe(9);
        expect((revived as Scoreboard).top(1).map((p) => p.id)).toEqual(['b']);
        expect(record.wrappers.has('scores')).toBe(true);
    });

    it('assigns an ordinary value straight through', () => {
        const record = createHostRecord('game');
        restoreHostField(record, 'round', 4);
        expect(record.values.get('round')).toBe(4);
    });
});

describe('reviveWrapper', () => {
    it('carries the ordering, so a low-is-better board is not silently inverted', () => {
        withPlayerLookup();
        const source = new Leaderboard({ order: 'low' });
        source.bind(createHostRecord('game'), 'times');
        source.submit(30, player('x'));
        source.submit(10, player('y'));

        const revived = reviveWrapper(source.serialize()) as Leaderboard;
        revived.bind(createHostRecord('game'), 'times');
        revived.restore(source.serialize());
        expect(revived.rankOf(player('y'))).toBe(1);
    });

    it('carries a Team’s name, which is its identity', () => {
        const source = new Team('red');
        source.bind(createHostRecord('game'), 'red');
        expect((reviveWrapper(source.serialize()) as Team).name).toBe('red');
    });

    it('resolves an Inventory’s player through the roster, and declines an unknown one', () => {
        withPlayerLookup();
        const source = new Inventory(player('a'));
        source.bind(createHostRecord('player:a'), 'bag');
        source.add('coin', 3);
        expect((reviveWrapper(source.serialize()) as Inventory).player.id).toBe('a');

        // No runtime, so no roster: guessing a player would attach the bag to the wrong one.
        clearRuntime();
        expect(reviveWrapper(source.serialize())).toBeUndefined();
    });

    it('declines anything that is not a wrapper payload', () => {
        expect(reviveWrapper({ kind: 'Something' })).toBeUndefined();
        expect(reviveWrapper(null)).toBeUndefined();
        expect(reviveWrapper(7)).toBeUndefined();
    });
});
