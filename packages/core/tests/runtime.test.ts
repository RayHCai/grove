// End-to-end runtime: loadGame → spawn → tag → find → addScript → send → destroy, with
// @serverState hoisted onto the entity host record. Fixtures compiled by the build.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Target } from '../dist/testkit/fixtures.js';
import { loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import { game } from '../src/runtime/game.js';
import { HUDScreen, hud } from '../src/runtime/hud.js';
import { Countdown } from '../src/runtime/wrappers.js';
import { bounds } from '@platform/math';

beforeEach(() => {
    loadGame({ role: 'server', bounds: bounds(-500, 500, 500, -500) });
});
afterEach(() => clearRuntime());

describe('runtime end to end', () => {
    it('spawns an entity and reads its transform back as a copy', () => {
        const e = game.spawn('crate', 10, 20);
        expect(e.position).toEqual({ x: 10, y: 20, z: 0 });
        const p = e.position;
        e.setPosition(99, 99);
        expect(p).toEqual({ x: 10, y: 20, z: 0 }); // the earlier read did not alias
        expect(e.position).toEqual({ x: 99, y: 99, z: 0 });
    });

    it('finds entities by tag', () => {
        const a = game.spawn('crate', 0, 0).tag('box');
        game.spawn('crate', 0, 0).tag('other');
        const found = game.find({ tag: 'box' });
        expect(found).toHaveLength(1);
        expect(found[0]).toBe(a);
    });

    it('returns the same facade for one id (=== identity)', () => {
        const a = game.spawn('crate', 0, 0);
        const again = game.find({ tag: 'x' });
        void again;
        expect(game.entities[0]).toBe(a);
    });

    it('destroy is logical-now: alive flips false before teardown drains', async () => {
        const e = game.spawn('crate', 0, 0);
        e.addScript(Target as never);
        await e.send('damage', { amount: 5 });
        expect(e.alive).toBe(false);
        expect(game.entities.some((x) => x === e)).toBe(true); // still present until the drain
    });

    it('hoists @serverState onto the entity host record and mutates through it', async () => {
        const e = game.spawn('crate', 0, 0);
        e.addScript(Target as never);
        await e.send('damage', { amount: 1 });
        // health started at 3, now 2 — read it back off the same record via a fresh handler
        await e.send('damage', { amount: 1 });
        expect(e.alive).toBe(true); // 3 - 1 - 1 = 1, still up
        await e.send('damage', { amount: 1 });
        expect(e.alive).toBe(false); // reached 0
    });

    it('a send to a dead entity is a no-op that resolves', async () => {
        const e = game.spawn('crate', 0, 0);
        e.addScript(Target as never);
        e.destroy();
        await expect(e.send('damage', { amount: 1 })).resolves.toBeUndefined();
    });
});

describe('hud', () => {
    it('is an inert instance, so a creator call is a no-op and not a TypeError', () => {
        expect(() => {
            hud.text('score', '10');
            hud.number('lives', 3);
            hud.bar('health', 0.5);
            hud.icon('badge', 'gold-star');
            hud.timer('clock', new Countdown(30));
            hud.show('score');
            hud.hide('score');
            hud.enable('score');
            hud.enable('score', false);
            hud.disable('score');
            hud.close('pause');
            hud.closeAll();
        }).not.toThrow();
        expect(hud.screen('pause')).toBeNull();
        expect(hud.player).toBeUndefined();
    });

    it('reads its screen lists as empty rather than throwing', () => {
        expect(hud.screens).toEqual([]);
        expect(hud.openScreens).toEqual([]);
        expect(hud.openScreens.length).toBe(0);
    });

    it('open() hands back an inert screen whose own methods no-op', () => {
        const screen = hud.open('pause');
        expect(screen).toBeInstanceOf(HUDScreen);
        expect(screen.name).toBe('');
        expect(screen.visible).toBe(false);
        expect(() => {
            screen.open();
            screen.close();
        }).not.toThrow();
        expect(screen.visible).toBe(false);
        expect(screen.addScript(Target as never)).toBe(screen);
        expect(hud.screens).toEqual([]);
        expect(hud.openScreens).toEqual([]);
    });
});
