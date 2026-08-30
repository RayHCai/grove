// Load order, lifecycle, request path, and wire-time rejections.

import { describe, it, expect, afterEach } from 'vitest';
import { Roll, Rules, SyncedWithRequest } from '../dist/testkit/fixtures.js';
import { loadGame, startGame, joinPlayer, leavePlayer } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import { request } from '../src/runtime/request.js';
import { Loop } from '../src/loop/loop.js';
import { game } from '../src/runtime/game.js';

afterEach(() => clearRuntime());

describe('game @onStart', () => {
    it('runs Game-hosted @onStart and seeds global @serverState', async () => {
        const rt = loadGame({ gameScripts: [Rules as never] });
        await startGame(rt);
        // `started` hoisted onto the game record; read via the game facade cast
        const w = game as unknown as { started: boolean };
        expect(w.started).toBe(true);
    });
});

describe('tick order', () => {
    it('adopts the tick index rather than incrementing — replaying 97 reports 97', () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        loop.step(97);
        expect(rt.tick).toBe(97);
        loop.step(97); // replay the same tick
        expect(rt.tick).toBe(97); // adopted, not incremented to 98
    });
});

describe('@onRequest loopback', () => {
    it('delivers a client request to a ServerScript handler', async () => {
        const rt = loadGame({ gameScripts: [Rules as never] });
        await startGame(rt);
        joinPlayer(rt, 'p1', 'Ada');
        request('grant', { amount: 25 });
        await tick();
        expect((game as unknown as { credits: number }).credits).toBe(25);
    });
});

describe('wire-time rejections', () => {
    it('rejects @onRequest on a non-ServerScript', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        expect(() => e.addScript(SyncedWithRequest as never)).toThrow(/@onRequest/);
    });
});

function tick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('leavePlayer', () => {
    it('dispatches @onPlayerLeave BEFORE the roster removal, then removes', async () => {
        const rt = loadGame({ gameScripts: [Roll as never] });
        await startGame(rt);
        joinPlayer(rt, 'p1', 'Ada');
        joinPlayer(rt, 'p2', 'Bo');
        const roll = [...rt.instances.forHost('game')][0]!.instance as Roll;
        expect(roll.joined).toStrictEqual(['p1', 'p2']);

        let rosterAtLeave = -1;
        roll.probe = () => {
            rosterAtLeave = rt.wired.playerManager.players.length;
        };
        leavePlayer(rt, 'p1');
        await tick();

        expect(roll.left).toStrictEqual(['p1']);
        // The handler is told about a player it must still be able to read: `player.avatar` and the
        // roster are both gone once `remove` has run.
        expect(rosterAtLeave).toBe(2);
        expect(rt.wired.playerManager.players.map((p) => p.id)).toStrictEqual(['p2']);
        expect(rt.hosts.get('player:p1')).toBeUndefined();
    });

    it('is a no-op for an unknown player', async () => {
        const rt = loadGame({ gameScripts: [Roll as never] });
        await startGame(rt);
        expect(() => leavePlayer(rt, 'nobody')).not.toThrow();
        const roll = [...rt.instances.forHost('game')][0]!.instance as Roll;
        expect(roll.left).toStrictEqual([]);
    });
});
