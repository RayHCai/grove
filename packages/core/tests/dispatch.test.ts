// Dispatch: synchronous-to-first-await, per-instance concurrency, cancellation across an
// await, destroy-during-dispatch, and the error boundary + breaker (DESIGN §4, §5.8, §11).

import { describe, it, expect, afterEach } from 'vitest';
import { Cooldown, Aimer, Faulty } from '../dist/testkit/fixtures.js';
import { loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import { BREAKER_THRESHOLD } from '../src/config.js';

afterEach(() => clearRuntime());

describe('concurrency (§4.2, §5.8)', () => {
    it('ignore drops a re-entry while the instance handler is running', async () => {
        const rt = loadGame();
        const e = rt.gameInstance!.spawn('crate', 0, 0);
        const inst = e.addScript(Cooldown as never) && instanceOf<Cooldown>(rt, e, 'Cooldown');

        void e.send('attack');
        void e.send('attack'); // dropped — first still running
        expect(inst.fires).toBe(1);

        inst.release();
        await tick();
        void e.send('attack'); // now allowed
        expect(inst.fires).toBe(2);
    });

    it('restart cancels the running invocation and starts fresh', async () => {
        const rt = loadGame();
        const e = rt.gameInstance!.spawn('crate', 0, 0);
        e.addScript(Aimer as never);
        const inst = instanceOf<Aimer>(rt, e, 'Aimer');

        void e.send('aim');
        void e.send('aim'); // cancels the first, starts a second
        expect(inst.starts).toBe(2);

        inst.release();
        await tick();
        // Only the live (second) invocation can finish; the cancelled first is swept.
        expect(inst.finishes).toBeLessThanOrEqual(1);
    });

    it('per-instance locking: two entities do not gate each other', () => {
        const rt = loadGame();
        const a = rt.gameInstance!.spawn('crate', 0, 0);
        const b = rt.gameInstance!.spawn('crate', 0, 0);
        a.addScript(Cooldown as never);
        b.addScript(Cooldown as never);
        void a.send('attack');
        void b.send('attack');
        expect(instanceOf<Cooldown>(rt, a, 'Cooldown').fires).toBe(1);
        expect(instanceOf<Cooldown>(rt, b, 'Cooldown').fires).toBe(1); // not gated by a
    });
});

describe('error boundary (§4.4)', () => {
    it('a throwing handler is caught, logged, and the world continues', async () => {
        const rt = loadGame();
        const e = rt.gameInstance!.spawn('crate', 0, 0);
        e.addScript(Faulty as never);
        await e.send('boom');
        expect(rt.log.records.length).toBeGreaterThanOrEqual(1);
        expect(rt.log.records[0]!.scriptClass).toBe('Faulty');
        expect(rt.log.records[0]!.method).toBe('boom');
    });

    it('the breaker disables a handler after ~100 consecutive throws', async () => {
        const rt = loadGame();
        const e = rt.gameInstance!.spawn('crate', 0, 0);
        e.addScript(Faulty as never);
        for (let i = 0; i < BREAKER_THRESHOLD + 5; i++) await e.send('boom');
        const disabled = rt.log.records.some(r => r.disabled === true);
        expect(disabled).toBe(true);
    });
});

// ── helpers ──────────────────────────────────────────────────────────────────────

function instanceOf<T>(rt: ReturnType<typeof loadGame>, e: { entityId: unknown }, className: string): T {
    for (const si of rt.instances.forHost(`entity:${e.entityId as number}`)) {
        if (si.className === className) return si.instance as T;
    }
    throw new Error(`${className} not attached`);
}

function tick(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}
