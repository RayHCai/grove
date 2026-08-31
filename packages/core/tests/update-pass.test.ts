// Pass 9 — `@onUpdate` — and the location rule that decides who it reaches.
//
// Both update passes force the SERVER's active locations whatever role built the runtime, so a
// `ClientScript`'s update never fires from `step`. That is not a filter for tidiness: a synced
// script's update belongs to the simulation, and a client running it from the frame loop as well
// would run it twice at two different rates and mispredict every tick it touched.

import { describe, it, expect, afterEach } from 'vitest';
import { ClientTicker, FaultyTicker, Rules, Ticker } from '../dist/testkit/fixtures.js';
import { endGame, loadGame, startGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import { Loop } from '../src/loop/loop.js';
import { entityKey } from '../src/runtime/hosts.js';
import { instanceOf } from './helpers.js';

afterEach(() => clearRuntime());

/** Yields a macrotask, draining the microtasks a dispatch's promise chain queues behind it. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the update pass', () => {
    it('runs a synced @onUpdate once per step', () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.addScript(Ticker as never);
        const ticker = instanceOf<Ticker>(rt, e, 'Ticker');

        expect(ticker.updates).toBe(0);
        loop.step(1);
        loop.step(2);
        loop.step(3);
        expect(ticker.updates).toBe(3);
    });

    it('hands it the tick’s dt, never a measured one', () => {
        const rt = loadGame({ simRate: 30 });
        const loop = new Loop(rt);
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.addScript(Ticker as never);

        loop.step(1);
        // 1/simRate exactly: two peers stepping the same tick must be handed the same number, and a
        // wall-clock delta is the one value that cannot be equal on both.
        expect(instanceOf<Ticker>(rt, e, 'Ticker').lastDt).toBe(1 / 30);
    });

    it('reaches every attached host, not only entities', async () => {
        const rt = loadGame({ gameScripts: [Ticker as never] });
        await startGame(rt);
        new Loop(rt).step(1);
        const gameTicker = [...rt.instances.forHost('game')][0]!.instance as Ticker;
        expect(gameTicker.updates).toBe(1);
    });

    it('does not run a client-located @onUpdate on a server runtime', () => {
        const rt = loadGame({ role: 'server' });
        const loop = new Loop(rt);
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.addScript(ClientTicker as never);

        loop.step(1);
        expect(instanceOf<ClientTicker>(rt, e, 'ClientTicker').updates).toBe(0);
    });

    it('does not run one on a CLIENT runtime either — displayUpdate owns that handler', () => {
        // The load-bearing half. A client's active locations are client+synced, so without the pass
        // forcing the server's set this would fire here AND from the frame loop.
        const rt = loadGame({ role: 'client' });
        const loop = new Loop(rt);
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.addScript(ClientTicker as never);
        e.addScript(Ticker as never);

        loop.step(1);
        expect(instanceOf<ClientTicker>(rt, e, 'ClientTicker').updates).toBe(0);
        // …and a synced one still runs, because that is the simulation's copy.
        expect(instanceOf<Ticker>(rt, e, 'Ticker').updates).toBe(1);
    });

    it('stops for a script whose host was torn down', () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.addScript(Ticker as never);
        const ticker = instanceOf<Ticker>(rt, e, 'Ticker');

        loop.step(1);
        e.destroy();
        loop.step(2);
        const atDeath = ticker.updates;
        loop.step(3);
        loop.step(4);
        expect(ticker.updates).toBe(atDeath);
    });

    it('contains a throw and names the host it happened on', async () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.addScript(FaultyTicker as never);

        expect(() => loop.step(1)).not.toThrow();
        await settle();

        const record = rt.log.records.find((r) => r.event === '@update');
        expect(record?.scriptClass).toBe('FaultyTicker');
        expect(record?.method).toBe('tick');
        // The host key, not the empty string: this pass dispatches per instance, and a record with
        // no host cannot be traced back to the entity that carries the broken script.
        expect(record?.hostId).toBe(entityKey(e.entityId as number));
    });

    it('keeps every other script updating after one of them throws', () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        const broken = rt.wired.gameInstance.spawn('crate', 0, 0);
        broken.addScript(FaultyTicker as never);
        const fine = rt.wired.gameInstance.spawn('crate', 0, 0);
        fine.addScript(Ticker as never);

        loop.step(1);
        loop.step(2);
        expect(instanceOf<Ticker>(rt, fine, 'Ticker').updates).toBe(2);
    });
});

describe('endGame and request records carry a host too', () => {
    it('an @onRequest throw names the host that carried the handler', async () => {
        // `@onRequest` is ServerScript-only, so the fixture is one; the throw is installed over its
        // handler because the point under test is `dispatchEach`'s host key, which every kind it
        // fires shares.
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.addScript(Rules as never);
        const si = rt.instances.forHost(entityKey(e.entityId as number))[0]!;
        Object.defineProperty(si.instance, 'grant', {
            configurable: true,
            value: () => {
                throw new Error('request always throws');
            },
        });

        rt.wired.requestSink('grant');
        await settle();

        expect(rt.log.records[0]?.hostId).toBe(entityKey(e.entityId as number));
        expect(rt.log.records[0]?.scriptClass).toBe('Rules');
    });

    it('an endGame @onEnd throw names its host too', async () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.addScript(Rules as never);
        const si = rt.instances.forHost(entityKey(e.entityId as number))[0]!;
        (si as { handlers: unknown }).handlers = [
            { event: '@end', kind: 'onEnd', methodName: 'grant', opts: {} },
        ];
        Object.defineProperty(si.instance, 'grant', {
            configurable: true,
            value: () => {
                throw new Error('end always throws');
            },
        });

        await endGame(rt);
        await settle();

        expect(rt.log.records[0]?.hostId).toBe(entityKey(e.entityId as number));
    });
});
