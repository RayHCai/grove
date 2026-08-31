import { describe, it, expect, afterEach } from 'vitest';
import { Cooldown, Aimer, Faulty, PhaseProbe } from '../dist/testkit/fixtures.js';
import { loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import { BREAKER_THRESHOLD } from '../src/config.js';
import { activeLocationsFor } from '../src/runtime/wiring.js';
import { entityKey } from '../src/runtime/hosts.js';
import { instanceOf } from './helpers.js';

afterEach(() => clearRuntime());

describe('concurrency', () => {
    it('ignore drops a re-entry while the instance handler is running', async () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        const inst = e.addScript(Cooldown as never) && instanceOf<Cooldown>(rt, e, 'Cooldown');

        void e.send('attack');
        void e.send('attack');
        expect(inst.fires).toBe(1);

        inst.release();
        await tick();
        void e.send('attack');
        expect(inst.fires).toBe(2);
    });

    it('restart cancels the running invocation and starts fresh', async () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.addScript(Aimer as never);
        const inst = instanceOf<Aimer>(rt, e, 'Aimer');

        void e.send('aim');
        void e.send('aim');
        expect(inst.starts).toBe(2);

        inst.release();
        await tick();
        // Exactly one, not "at most one": the fixture's release resolves the live invocation's own
        // await, so a restart that cancelled BOTH would leave this at zero and read as a pass.
        expect(inst.finishes).toBe(1);
    });

    it('per-instance locking: two entities do not gate each other', () => {
        const rt = loadGame();
        const a = rt.wired.gameInstance.spawn('crate', 0, 0);
        const b = rt.wired.gameInstance.spawn('crate', 0, 0);
        a.addScript(Cooldown as never);
        b.addScript(Cooldown as never);
        void a.send('attack');
        void b.send('attack');
        expect(instanceOf<Cooldown>(rt, a, 'Cooldown').fires).toBe(1);
        expect(instanceOf<Cooldown>(rt, b, 'Cooldown').fires).toBe(1); // not gated by a
    });
});

describe('error boundary', () => {
    it('a throwing handler is caught, logged, and the world continues', async () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.addScript(Faulty as never);
        await e.send('boom');
        expect(rt.log.records.length).toBeGreaterThanOrEqual(1);
        expect(rt.log.records[0]!.scriptClass).toBe('Faulty');
        expect(rt.log.records[0]!.method).toBe('boom');
    });

    it('the breaker disables a handler after ~100 consecutive throws', async () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.addScript(Faulty as never);
        for (let i = 0; i < BREAKER_THRESHOLD + 5; i++) await e.send('boom');
        const disabled = rt.log.records.some((r) => r.disabled === true);
        expect(disabled).toBe(true);
    });
});

describe('input phase matching', () => {
    it('an onEvent dispatch naming a phase reaches only handlers declaring that phase', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.addScript(PhaseProbe as never);
        const probe = instanceOf<PhaseProbe>(rt, e, 'PhaseProbe');

        fire(rt, e, 'jump', 'press');
        expect([probe.presses, probe.releases, probe.holds]).toStrictEqual([1, 0, 0]);

        fire(rt, e, 'jump', 'hold');
        fire(rt, e, 'jump', 'hold');
        expect([probe.presses, probe.releases, probe.holds]).toStrictEqual([1, 0, 2]);

        fire(rt, e, 'jump', 'release');
        expect([probe.presses, probe.releases, probe.holds]).toStrictEqual([1, 1, 2]);
    });

    it('an UNPHASED dispatch still reaches every handler on the action — Entity.send', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.addScript(PhaseProbe as never);
        const probe = instanceOf<PhaseProbe>(rt, e, 'PhaseProbe');

        // `on` is meaningless on a creator-sent event, so a send that names no edge matches any
        // declaration — which is also what keeps this change backwards-compatible.
        void e.send('jump');
        expect([probe.presses, probe.releases, probe.holds]).toStrictEqual([1, 1, 1]);
    });
});

function tick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/** One phased input dispatch at an entity host, the shape the server's input pass produces. */
function fire(
    rt: ReturnType<typeof loadGame>,
    e: { entityId: unknown },
    action: string,
    phase: 'press' | 'release' | 'hold',
): void {
    const hostKey = entityKey(e.entityId as number);
    void rt.dispatcher.dispatch(
        rt.instances.forHost(hostKey),
        'onEvent',
        action,
        hostKey,
        { data: {}, dt: 1 / rt.simRate, alive: true },
        { activeLocations: activeLocationsFor('server'), tick: rt.tick, phase },
    );
}
