// The engine's own bounds.
//
// Each of these exists so a session that runs for hours, or a peer that misbehaves for as long as
// it likes, cannot grow something without end. None of them is reachable from the creator API, so
// none has a natural caller to notice if it stopped working — a deleted cap looks exactly like a
// working one until the machine that hits it is already in trouble.

import { describe, it, expect, afterEach } from 'vitest';
import {
    DEFAULT_SEND_RATE,
    DEFAULT_SIM_RATE,
    MAX_BUBBLE_LENGTH,
    MAX_DEDUP_KEYS,
    MAX_LOG_RECORDS,
    MAX_SEND_DEPTH,
    resolveConfig,
} from '../src/config.js';
import { CollectingLog, clearRuntime } from '../src/runtime/runtime.js';
import { loadGame } from '../src/runtime/load-game.js';
import type { Runtime } from '../src/runtime/runtime.js';
import type { ScriptInstance } from '../src/dispatch/instances.js';
import { activeLocationsFor } from '../src/runtime/wiring.js';
import { entityKey } from '../src/runtime/hosts.js';
import type { Entity } from '../src/runtime/entity.js';

afterEach(() => clearRuntime());

let nextProbeId = 20_000;

/** Stands in for a script class; the dispatcher only ever reads its identity. */
class ProbeClass {
    readonly kind = 'probe';
}

/** A guard site for the unowned-callback cases, which carry no host of their own. */
function siteAt(
    tick: number,
    method = 'go',
): {
    method: string;
    hostId: string;
    tick: number;
    event: string;
} {
    return { method, hostId: 'game', tick, event: '@probe' };
}

/**
 * A hand-built instance whose one handler runs `body`.
 *
 * `concurrent` rather than the `onEvent` default of `ignore`: a re-entrant send is exactly what the
 * depth guard is for, and `ignore` drops the second call before the depth ever grows — which is why
 * a naive recursion test passes without the guard existing at all.
 */
function probe(rt: Runtime, entity: Entity, body: () => void): ScriptInstance {
    const hostKey = entityKey(entity.entityId as number);
    return {
        id: nextProbeId++,
        instance: { go: body },
        klass: ProbeClass,
        className: 'Probe',
        location: 'synced',
        handlers: [
            { event: 'go', kind: 'onEvent', methodName: 'go', opts: { concurrency: 'concurrent' } },
        ],
        hostScopeId: rt.hosts.ensure(hostKey).scopeId,
    };
}

describe('resolveConfig', () => {
    it('fills the documented defaults', () => {
        expect(resolveConfig()).toStrictEqual({
            simRate: DEFAULT_SIM_RATE,
            sendRate: DEFAULT_SEND_RATE,
            maxPlayers: 8,
        });
        expect(DEFAULT_SIM_RATE).toBe(60);
        expect(DEFAULT_SEND_RATE).toBe(20);
    });

    it('keeps every field the caller supplied', () => {
        expect(resolveConfig({ simRate: 30, sendRate: 10, maxPlayers: 2 })).toStrictEqual({
            simRate: 30,
            sendRate: 10,
            maxPlayers: 2,
        });
    });

    it('fills only the fields left out', () => {
        expect(resolveConfig({ simRate: 120 })).toStrictEqual({
            simRate: 120,
            sendRate: DEFAULT_SEND_RATE,
            maxPlayers: 8,
        });
    });
});

describe('MAX_SEND_DEPTH', () => {
    it('stops a send chain that re-enters itself, and says so in the log', async () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        let depth = 0;
        const si = probe(rt, e, () => {
            depth += 1;
            void e.send('go');
        });
        rt.instances.attach(entityKey(e.entityId as number), si);

        await e.send('go');

        // Bounded, and bounded at the documented number rather than by the stack running out.
        expect(depth).toBe(MAX_SEND_DEPTH);
        const record = rt.log.records.find((r) => r.scriptClass === '(engine)');
        expect(record?.method).toBe('dispatch');
        expect(record?.stack).toContain(`depth ${MAX_SEND_DEPTH}`);
    });

    it('recovers, so the next send from the top starts at depth zero again', async () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        let depth = 0;
        rt.instances.attach(
            entityKey(e.entityId as number),
            probe(rt, e, () => {
                depth += 1;
                if (depth < MAX_SEND_DEPTH * 2) void e.send('go');
            }),
        );

        await e.send('go');
        const first = depth;
        depth = 0;
        await e.send('go');
        // The counter unwinds in a `finally`, so one overflowing chain does not poison the next.
        expect(depth).toBe(first);
    });

    it('leaves an ordinary nested send well inside the bound', async () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        let depth = 0;
        rt.instances.attach(
            entityKey(e.entityId as number),
            probe(rt, e, () => {
                depth += 1;
                if (depth < 3) void e.send('go');
            }),
        );

        await e.send('go');
        expect(depth).toBe(3);
        expect(rt.log.records).toHaveLength(0);
    });
});

describe('MAX_DEDUP_KEYS', () => {
    it('clears rather than growing once the distinct-message map fills', () => {
        // Through an UNOWNED guard, which is the only way to reach this cap: an owned handler is
        // disabled by the breaker after 100 consecutive throws, long before 1024 distinct messages
        // exist. An unowned callback has no instance to charge, so it throws for as long as it likes
        // — which is exactly the case this bound is here for.
        const rt = loadGame();
        const throwOnce = (n: number): void => {
            rt.dispatcher.guard(null, siteAt(n), () => {
                throw new Error(`distinct message ${n}`);
            });
        };

        for (let i = 0; i < MAX_DEDUP_KEYS; i++) throwOnce(i);
        expect(rt.dispatcher.throwCount('(engine)', 'go', 'distinct message 0')).toBe(1);

        throwOnce(MAX_DEDUP_KEYS); // the one past the cap
        // Cleared wholesale, which is what keeps the bound O(1) rather than an eviction walk.
        expect(rt.dispatcher.throwCount('(engine)', 'go', 'distinct message 0')).toBe(0);
        expect(
            rt.dispatcher.throwCount('(engine)', 'go', `distinct message ${MAX_DEDUP_KEYS}`),
        ).toBe(1);
    });

    it('an unowned callback is contained and logged but never disabled', () => {
        // The half that makes the cap above reachable at all, and the reason it has to exist.
        const rt = loadGame();
        for (let i = 0; i < 300; i++) {
            rt.dispatcher.guard(null, siteAt(i, 'cb'), () => {
                throw new Error('unowned always throws');
            });
        }
        expect(rt.dispatcher.throwCount('(engine)', 'cb', 'unowned always throws')).toBe(300);
        expect(rt.log.records.some((r) => r.disabled)).toBe(false);
    });

    it('keeps counting a repeated message rather than clearing on it', async () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        rt.instances.attach(
            entityKey(e.entityId as number),
            probe(rt, e, () => {
                throw new Error('the same message every time');
            }),
        );

        for (let i = 0; i < 20; i++) await e.send('go');
        expect(rt.dispatcher.throwCount('Probe', 'go', 'the same message every time')).toBe(20);
        // One record for twenty throws: the repeats are counted, never logged.
        expect(rt.log.records.filter((r) => !r.disabled)).toHaveLength(1);
    });
});

describe('MAX_LOG_RECORDS', () => {
    it('keeps the most recent and drops the oldest', () => {
        const log = new CollectingLog();
        for (let i = 0; i < MAX_LOG_RECORDS + 50; i++) {
            log.error({
                scriptClass: 'C',
                method: 'm',
                hostId: 'game',
                tick: i,
                event: 'e',
                stack: `record ${i}`,
            });
        }

        expect(log.records).toHaveLength(MAX_LOG_RECORDS);
        // A ring, not a stop: the newest failures are the ones worth having, and a log that filled
        // and then refused writes would hide the crash that followed the first 512.
        expect(log.records[0]?.stack).toBe('record 50');
        expect(log.records.at(-1)?.stack).toBe(`record ${MAX_LOG_RECORDS + 49}`);
    });

    it('warnings stay out of the error records', () => {
        const log = new CollectingLog();
        log.warn('something worth saying in a dev console');
        expect(log.records).toHaveLength(0);
    });
});

describe('MAX_BUBBLE_LENGTH', () => {
    it('truncates the text rather than putting an unbounded string on the wire', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        rt.channels.drainStructural();

        e.say('x'.repeat(MAX_BUBBLE_LENGTH + 500));
        const ops = rt.channels.drainStructural();
        expect(ops).toHaveLength(1);
        const op = ops[0]!;
        if (op.kind !== 'tag') throw new Error('expected a tag op');
        expect(op.tag).toBe(`say:${'x'.repeat(MAX_BUBBLE_LENGTH)}`);
    });

    it('leaves a short bubble untouched', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        rt.channels.drainStructural();

        e.say('hello');
        const op = rt.channels.drainStructural()[0]!;
        if (op.kind !== 'tag') throw new Error('expected a tag op');
        expect(op.tag).toBe('say:hello');
    });

    it('carries one bubble at a time — a second say clears the first', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.say('first');
        rt.channels.drainStructural();

        e.say('second');
        expect(rt.channels.drainStructural()).toStrictEqual([
            { kind: 'tag', id: e.entityId, tag: 'say:first', added: false },
            { kind: 'tag', id: e.entityId, tag: 'say:second', added: true },
        ]);
    });

    it('clearSay journals the removal, and is a no-op with nothing to clear', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.say('gone');
        rt.channels.drainStructural();

        e.clearSay();
        expect(rt.channels.drainStructural()).toStrictEqual([
            { kind: 'tag', id: e.entityId, tag: 'say:gone', added: false },
        ]);

        // Nothing left to remove: an unconditional op would tell a client to drop a tag it never had.
        e.clearSay();
        expect(rt.channels.structuralCount).toBe(0);
    });

    it('a timed bubble clears itself, and only its own', async () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        rt.hosts.ensure(entityKey(e.entityId as number));

        const timed = e.say('first', 2 / rt.simRate);
        e.say('second'); // replaces it mid-sleep
        rt.channels.drainStructural();

        rt.timers.advance();
        rt.timers.advance();
        await timed;

        // The sleep woke and found a different bubble in place, so it left it alone.
        expect(rt.channels.structuralCount).toBe(0);
    });
});

describe('the depth guard uses the same dispatch path as everything else', () => {
    it('does not fire for the ordinary breadth of a whole-world dispatch', async () => {
        // Depth is re-entry, not fan-out: a hundred instances each taking one dispatch is depth 1.
        const rt = loadGame();
        for (let i = 0; i < 100; i++) {
            const e = rt.wired.gameInstance.spawn('crate', i, 0);
            rt.instances.attach(
                entityKey(e.entityId as number),
                probe(rt, e, () => {}),
            );
        }
        await rt.dispatcher.dispatch(
            [...rt.instances.all()],
            'onEvent',
            'go',
            'game',
            { data: {}, dt: 1 / rt.simRate, alive: true },
            { activeLocations: activeLocationsFor('server'), tick: 0 },
        );
        expect(rt.log.records).toHaveLength(0);
    });
});
