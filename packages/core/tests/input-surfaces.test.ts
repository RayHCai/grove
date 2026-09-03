// The three creator-facing surfaces core answers for without owning what is behind them: a cursor
// with no pointer, a binding table with no device, and the region-backed random draw.
//
// Two of them are deliberately inert here — a server has no pointer and no keyboard — so what these
// cases pin is that reading one is safe and that writing one is remembered, which is what a script
// running on both ends depends on.

import { describe, it, expect, afterEach } from 'vitest';
import { bounds } from '@platform/math';
import { joinPlayer, loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';

afterEach(() => clearRuntime());

const ZONE = 'zone';
const ZONE_BOUNDS = bounds(-40, 60, 30, -20);

describe('a player cursor with no pointer behind it', () => {
    it('reads as an origin nobody is over, rather than throwing or answering null', () => {
        const rt = loadGame();
        const player = joinPlayer(rt, 'p1', 'P');
        expect(player.cursor.position).toEqual({ x: 0, y: 0, z: 0 });
        expect(player.cursor.screenPosition).toEqual({ x: 0, y: 0, z: 0 });
        expect(player.cursor.over).toBeNull();
        expect(player.cursor.isDown).toBe(false);
    });

    it('takes every write without effect, so shared code need not ask which end it is on', () => {
        const rt = loadGame();
        const player = joinPlayer(rt, 'p1', 'P');
        expect(() => player.cursor.setIcon('crosshair')).not.toThrow();
        expect(() => player.cursor.lock()).not.toThrow();
        expect(() => player.cursor.unlock()).not.toThrow();
        player.cursor.visible = false;
        // Presentation-only and client-owned: the server keeps no cursor state to be asked for later.
        expect(player.cursor.isDown).toBe(false);
    });

    it('is the same object every read, so a handler may hold on to it', () => {
        const rt = loadGame();
        const player = joinPlayer(rt, 'p1', 'P');
        expect(player.cursor).toBe(player.cursor);
    });
});

describe('a player binding table', () => {
    it('remembers a rebind and hands the same list back', () => {
        const rt = loadGame();
        const player = joinPlayer(rt, 'p1', 'P');
        player.input.rebind('jump', ['Space', 'KeyJ']);
        expect(player.input.getBindings('jump')).toEqual(['Space', 'KeyJ']);
    });

    it('appends with addBinding rather than replacing what rebind set', () => {
        const rt = loadGame();
        const player = joinPlayer(rt, 'p1', 'P');
        player.input.rebind('jump', ['Space']);
        player.input.addBinding('jump', 'KeyJ');
        expect(player.input.getBindings('jump')).toEqual(['Space', 'KeyJ']);
    });

    it('answers an unbound action with an empty list, never undefined', () => {
        const rt = loadGame();
        const player = joinPlayer(rt, 'p1', 'P');
        expect(player.input.getBindings('never-bound')).toEqual([]);
    });

    it('resets one action by name and every action when given none', () => {
        const rt = loadGame();
        const player = joinPlayer(rt, 'p1', 'P');
        player.input.rebind('jump', ['Space']);
        player.input.rebind('fire', ['Mouse0']);

        player.input.resetBindings('jump');
        expect(player.input.getBindings('jump')).toEqual([]);
        expect(player.input.getBindings('fire')).toEqual(['Mouse0']);

        player.input.resetBindings();
        expect(player.input.getBindings('fire')).toEqual([]);
    });

    it('takes a context without effect, the device that would honour one being the client’s', () => {
        const rt = loadGame();
        const player = joinPlayer(rt, 'p1', 'P');
        player.input.rebind('jump', ['Space']);
        player.input.setContext('menu');
        expect(player.input.getBindings('jump')).toEqual(['Space']);
    });

    it('is per player, so one rebinding leaves the other alone', () => {
        const rt = loadGame();
        const one = joinPlayer(rt, 'p1', 'One');
        const two = joinPlayer(rt, 'p2', 'Two');
        one.input.rebind('jump', ['Space']);
        expect(two.input.getBindings('jump')).toEqual([]);
    });
});

describe('a random point in a region', () => {
    it('lands inside the authored rectangle, every draw', () => {
        const rt = loadGame({ regions: [{ name: ZONE, bounds: ZONE_BOUNDS }] }, { seed: 7 });
        for (let i = 0; i < 50; i++) {
            const at = rt.wired.random.pointIn(ZONE);
            expect(at.x).toBeGreaterThanOrEqual(ZONE_BOUNDS.left);
            expect(at.x).toBeLessThanOrEqual(ZONE_BOUNDS.right);
            expect(at.y).toBeGreaterThanOrEqual(ZONE_BOUNDS.bottom);
            expect(at.y).toBeLessThanOrEqual(ZONE_BOUNDS.top);
            // z is reserved for the 3D backend, so a 2D draw must not wander onto it.
            expect(at.z).toBe(0);
        }
    });

    it('answers the origin for a region nothing authored, rather than throwing mid-tick', () => {
        const rt = loadGame({ regions: [{ name: ZONE, bounds: ZONE_BOUNDS }] });
        expect(rt.wired.random.pointIn('no-such-region')).toEqual({ x: 0, y: 0, z: 0 });
    });

    it('draws the same sequence from the same seed, because a replay has to agree', () => {
        const manifest = { regions: [{ name: ZONE, bounds: ZONE_BOUNDS }] };
        const first = loadGame(manifest, { seed: 99 });
        const drawn = [first.wired.random.pointIn(ZONE), first.wired.random.pointIn(ZONE)];
        clearRuntime();

        const second = loadGame(manifest, { seed: 99 });
        expect([second.wired.random.pointIn(ZONE), second.wired.random.pointIn(ZONE)]).toEqual(
            drawn,
        );
    });
});
