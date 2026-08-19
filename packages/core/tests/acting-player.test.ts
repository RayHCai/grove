// The dispatcher's acting-player ambient: what `scores.add(1)` credits with no player argument,
// and that the ambient is a strict save/restore around one handler call. The instances here are
// hand-built rather than decorated fixtures, so the dispatcher and the ambient it writes are the
// same module copies the wrappers read.

import { describe, it, expect, afterEach } from 'vitest';
import { Leaderboard, Scoreboard } from '../src/runtime/wrappers.js';
import { createHostRecord } from '../src/state/host-record.js';
import { clearRuntime, createRuntime } from '../src/runtime/runtime.js';
import type { Runtime } from '../src/runtime/runtime.js';
import { currentActingPlayer } from '../src/dispatch/acting-player.js';
import { activeLocationsFor } from '../src/runtime/wiring.js';
import type { ScriptInstance } from '../src/dispatch/instances.js';
import type { Player } from '../src/runtime/player.js';

const player = (id: string) => ({ id, name: id }) as unknown as Player;

let nextId = 9000;

class Probe {
    readonly go: () => unknown;

    constructor(go: () => unknown) {
        this.go = go;
    }
}

/** One server-located instance whose only handler is `onEvent('go')` running `body`. */
function probe(rt: Runtime, body: () => unknown): ScriptInstance {
    return {
        id: nextId++,
        instance: new Probe(body),
        klass: Probe,
        className: 'Probe',
        location: 'server',
        handlers: [{ event: 'go', kind: 'onEvent', methodName: 'go', opts: {} }],
        hostScopeId: rt.scopes.createHostScope(),
    };
}

function fire(rt: Runtime, si: ScriptInstance, actor: Player | undefined): Promise<void> {
    return rt.dispatcher.dispatch(
        [si],
        'onEvent',
        'go',
        'game',
        { data: {}, dt: 1 / rt.simRate, alive: true, player: actor },
        { activeLocations: activeLocationsFor('server'), tick: rt.tick },
    );
}

function boundScoreboard(): Scoreboard {
    const s = new Scoreboard();
    s.bind(createHostRecord('game'), 'scores');
    return s;
}

afterEach(() => clearRuntime());

describe('acting player', () => {
    it('scores.add(1) inside a player-driven handler credits ctx.player', async () => {
        const rt = createRuntime();
        const s = boundScoreboard();
        const p = player('a');

        await fire(
            rt,
            probe(rt, () => s.add(1)),
            p,
        );

        expect(s.of(p)).toBe(1);
        expect(s.of(player('b'))).toBe(0);
    });

    it('scores.add(1) outside any handler throws the documented error', () => {
        createRuntime();
        const s = boundScoreboard();
        expect(currentActingPlayer()).toBeNull();
        expect(() => s.add(1)).toThrow('Scoreboard.add needs a player');
    });

    it('a handler with no ctx.player gets no acting player', async () => {
        const rt = createRuntime();
        const s = boundScoreboard();
        let thrown: unknown;

        await fire(
            rt,
            probe(rt, () => {
                try {
                    s.add(1);
                } catch (err) {
                    thrown = err;
                }
            }),
            undefined,
        );

        expect((thrown as Error).message).toContain('there is no acting player');
    });

    it('restores the outer handler as the acting player after a nested dispatch', async () => {
        const rt = createRuntime();
        const s = boundScoreboard();
        const outer = player('outer');
        const inner = player('inner');
        const nested = probe(rt, () => s.add(10));

        await fire(
            rt,
            probe(rt, () => {
                void fire(rt, nested, inner);
                s.add(1);
            }),
            outer,
        );

        expect(s.of(inner)).toBe(10);
        expect(s.of(outer)).toBe(1); // not credited to the nested handler's player
        expect(currentActingPlayer()).toBeNull();
    });

    it('restores the acting player after a nested handler throws', async () => {
        const rt = createRuntime();
        const s = boundScoreboard();
        const outer = player('outer');
        const thrower = probe(rt, () => {
            throw new Error('nested handler always throws');
        });

        await fire(
            rt,
            probe(rt, () => {
                void fire(rt, thrower, player('inner'));
                s.add(1);
            }),
            outer,
        );

        expect(s.of(outer)).toBe(1);
        expect(currentActingPlayer()).toBeNull();
    });

    it('a handler parked on an await leaves no acting player behind', () => {
        const rt = createRuntime();
        void fire(
            rt,
            probe(rt, () => new Promise<void>(() => {})),
            player('a'),
        );
        expect(currentActingPlayer()).toBeNull();
    });

    it('a continuation resumed after an await has no acting player', async () => {
        const rt = createRuntime();
        const s = boundScoreboard();
        const p = player('a');
        let thrown: unknown;

        await fire(
            rt,
            probe(rt, async () => {
                await Promise.resolve();
                try {
                    s.add(1);
                } catch (err) {
                    thrown = err;
                }
            }),
            p,
        );

        expect((thrown as Error).message).toContain('there is no acting player');
        expect(s.of(p)).toBe(0);
    });

    it('an explicit player argument beats the ambient', async () => {
        const rt = createRuntime();
        const s = boundScoreboard();
        const driver = player('a');
        const credited = player('b');

        await fire(
            rt,
            probe(rt, () => s.add(1, credited)),
            driver,
        );

        expect(s.of(credited)).toBe(1);
        expect(s.of(driver)).toBe(0);
    });

    it('Leaderboard.submit still needs an explicit player inside a handler', async () => {
        const rt = createRuntime();
        const lb = new Leaderboard({ order: 'high' });
        lb.bind(createHostRecord('game'), 'wins');
        let thrown: unknown;

        await fire(
            rt,
            probe(rt, () => {
                try {
                    lb.submit(5);
                } catch (err) {
                    thrown = err;
                }
            }),
            player('a'),
        );

        expect((thrown as Error).message).toBe(
            'Leaderboard.submit needs the player whose score it is',
        );
    });
});
