// Load order, lifecycle, request path, and wire-time rejections (DESIGN §8.2, §8.3, §5.9).

import { describe, it, expect, afterEach } from 'vitest';
import { Rules, SyncedWithRequest } from '../dist/testkit/fixtures.js';
import { loadGame, startGame, joinPlayer } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import { request } from '../src/runtime/request.js';
import { Loop } from '../src/loop/loop.js';
import { game } from '../src/runtime/game.js';

afterEach(() => clearRuntime());

describe('game @onStart (§8.3)', () => {
    it('runs Game-hosted @onStart and seeds global @serverState', async () => {
        const rt = loadGame({ gameScripts: [Rules as never] });
        await startGame(rt);
        // `started` hoisted onto the game record; read via the game facade cast
        const w = game as unknown as { started: boolean };
        expect(w.started).toBe(true);
    });
});

describe('tick order (§8.2)', () => {
    it('adopts the tick index rather than incrementing — replaying 97 reports 97', () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        loop.step(97);
        expect(rt.tick).toBe(97);
        loop.step(97); // replay the same tick
        expect(rt.tick).toBe(97); // adopted, not incremented to 98
    });
});

describe('@onRequest loopback (§5.9)', () => {
    it('delivers a client request to a ServerScript handler', async () => {
        const rt = loadGame({ gameScripts: [Rules as never] });
        await startGame(rt);
        joinPlayer(rt, 'p1', 'Ada');
        request('grant', { amount: 25 });
        await tick();
        expect((game as unknown as { credits: number }).credits).toBe(25);
    });
});

describe('wire-time rejections (§5.9)', () => {
    it('rejects @onRequest on a non-ServerScript', () => {
        const rt = loadGame();
        const e = rt.gameInstance!.spawn('crate', 0, 0);
        expect(() => e.addScript(SyncedWithRequest as never)).toThrow(/@onRequest/);
    });
});

function tick(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}
