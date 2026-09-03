// End-to-end runtime: loadGame → spawn → tag → find → addScript → send → destroy, with
// @serverState hoisted onto the entity host record. Fixtures compiled by the build.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Menu, OtherMenu, Rules, Shopper, Target } from '../dist/testkit/fixtures.js';
import { joinPlayer, loadGame, pressWidget } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import type { Runtime } from '../src/runtime/runtime.js';
import { game } from '../src/runtime/game.js';
import { HUDScreen, hud } from '../src/runtime/hud.js';
import { Countdown } from '../src/runtime/wrappers.js';
import { entityKey } from '../src/runtime/hosts.js';
import { instanceOf } from './helpers.js';
import { bounds } from '@platform/math';

const BOUNDS = bounds(-500, 500, 500, -500);

/** The server world every test here starts from; a HUD test builds its own client one. */
let server: Runtime;

beforeEach(() => {
    server = loadGame({ role: 'server', bounds: BOUNDS });
});
afterEach(() => clearRuntime());

/**
 * A client world, which is the only kind that has a HUD.
 *
 * `role` is the location filter, so a `ClientScript<HUDScreen>` is inert on a server runtime — and
 * the whole HUD surface is client-side by construction.
 */
function clientWorld(): Runtime {
    const rt = loadGame({ role: 'client', bounds: BOUNDS });
    rt.localPlayer = joinPlayer(rt, 'p1', 'Ada');
    return rt;
}

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
        const a = game.spawn('crate', 0, 0).tag('box');
        // Every route to the entity is the same object, which is what lets a creator hold one and
        // compare it against whatever a query hands back later.
        expect(game.entities[0]).toBe(a);
        expect(game.find({ tag: 'box' })[0]).toBe(a);
        expect(server.entityManager.facade(a.entityId)).toBe(a);
    });

    it('does not hand a reused slot the facade of the entity that freed it', () => {
        const first = game.spawn('crate', 0, 0);
        first.destroy();
        server.entityManager.drainDestroyed();

        const second = game.spawn('crate', 0, 0);
        // The slot index is the same; the generation is not. Caching on the index alone would
        // return `first` here, and a handler holding it would write through a dead facade.
        expect(second).not.toBe(first);
        expect(second.alive).toBe(true);
        expect(first.alive).toBe(false);
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
        const record = server.hosts.get(entityKey(e.entityId as number))!.record;
        const script = instanceOf<{ health: number }>(server, e, 'Target');

        // The record is what replicates, so all three spellings have to be one value — a hoist that
        // left the instance holding its own copy passes every `alive` assertion below and still
        // sends the initializer over the wire forever.
        expect(record.values.get('health')).toBe(3);
        expect((e as unknown as { health: number }).health).toBe(3);
        expect(script.health).toBe(3);

        await e.send('damage', { amount: 1 });
        expect(record.values.get('health')).toBe(2);
        expect((e as unknown as { health: number }).health).toBe(2);
        expect(script.health).toBe(2);

        await e.send('damage', { amount: 1 });
        expect(e.alive).toBe(true); // 3 - 1 - 1 = 1, still up
        await e.send('damage', { amount: 1 });
        expect(e.alive).toBe(false); // reached 0
        expect(record.values.get('downed')).toBe(true);
    });

    it('a send to a dead entity is a no-op that resolves', async () => {
        const e = game.spawn('crate', 0, 0);
        e.addScript(Target as never);
        e.destroy();
        await expect(e.send('damage', { amount: 1 })).resolves.toBeUndefined();
    });
});

describe('hud widgets', () => {
    it('records what each verb wrote and pushes the whole record at the seam', () => {
        const rt = clientWorld();
        const pushed: string[] = [];
        rt.hudSink = {
            widget: (name) => pushed.push(name),
            screen: () => {},
        };

        const clock = new Countdown(30);
        hud.text('score', '10');
        hud.number('lives', 3);
        hud.bar('health', 0.5);
        hud.icon('badge', 'gold-star');
        hud.timer('clock', clock);
        hud.disable('score');
        hud.hide('badge');

        expect(hud.widget('score')).toEqual({ text: '10', visible: true, enabled: false });
        expect(hud.widget('lives')?.number).toBe(3);
        expect(hud.widget('health')?.fraction).toBe(0.5);
        expect(hud.widget('badge')).toEqual({ icon: 'gold-star', visible: false, enabled: true });
        // The Countdown itself, not a sampled number: a bound timer counts down with no further call.
        expect(hud.widget('clock')?.countdown).toBe(clock);
        expect(pushed).toStrictEqual([
            'score',
            'lives',
            'health',
            'badge',
            'clock',
            'score',
            'badge',
        ]);
    });

    it('reads an untouched widget as null and defaults a touched one to shown and enabled', () => {
        clientWorld();
        expect(hud.widget('never-written')).toBeNull();
        hud.text('score', '1');
        expect(hud.widget('score')).toEqual({ text: '1', visible: true, enabled: true });
    });
});

describe('hud.player', () => {
    it('throws on a runtime with no local player rather than reading undefined off a field', () => {
        // The defect the declared `readonly player!: Player` hid: a server runtime has no local
        // player, and reaching `hud` from there is the load-time error the wiring rules already name.
        expect(() => hud.player).toThrow(/no player/);
    });

    it('returns the owning player once the runtime carries one', () => {
        const rt = clientWorld();
        expect(hud.player).toBe(rt.localPlayer);
        expect(hud.player.id).toBe('p1');
    });
});

describe('hud screens', () => {
    it('is empty until a screen is named, and open() mints and shows a real one', () => {
        clientWorld();
        expect(hud.screen('pause')).toBeNull();
        expect(hud.screens).toEqual([]);
        expect(hud.openScreens).toEqual([]);

        const screen = hud.open('pause');
        expect(screen).toBeInstanceOf(HUDScreen);
        expect(screen.name).toBe('pause');
        expect(screen.visible).toBe(true);
        expect(hud.screen('pause')).toBe(screen);
        expect(hud.openScreens.map((s) => s.name)).toStrictEqual(['pause']);
    });

    it('opens and closes idempotently, and closeAll empties the stack', () => {
        clientWorld();
        hud.open('pause');
        hud.open('pause'); // second open is not a second entry
        hud.open('shop');
        expect(hud.openScreens.map((s) => s.name)).toStrictEqual(['pause', 'shop']);

        hud.close('pause');
        hud.close('pause');
        expect(hud.openScreens.map((s) => s.name)).toStrictEqual(['shop']);
        expect(hud.screen('pause')?.visible).toBe(false);
        // Closed, not forgotten: it stays authored so a later open finds the same screen.
        expect(hud.screens.map((s) => s.name)).toStrictEqual(['pause', 'shop']);

        hud.closeAll();
        expect(hud.openScreens).toEqual([]);
    });

    it('attaches the screen scripts at open and discards them at close', () => {
        const rt = clientWorld();
        const screen = hud.open('shop');
        hud.close('shop');
        screen.addScript(Menu as never);

        // Registered, not attached: a screen never opened since has no instances.
        expect([...rt.instances.forHost('screen:shop')]).toHaveLength(0);

        hud.open('shop');
        const menu = [...rt.instances.forHost('screen:shop')][0]!.instance as Menu;
        expect(menu.starts).toBe(1);

        hud.close('shop');
        expect(menu.ends).toBe(1);
        // Closing DISCARDS client state, so the reopen builds a fresh instance rather than this one.
        expect([...rt.instances.forHost('screen:shop')]).toHaveLength(0);
        hud.open('shop');
        expect([...rt.instances.forHost('screen:shop')][0]!.instance).not.toBe(menu);
    });

    it('rejects a ServerScript on a screen host, because a screen exists on one machine', () => {
        clientWorld();
        const screen = hud.open('pause');
        hud.close('pause');
        screen.addScript(Rules as never);
        expect(() => hud.open('pause')).toThrow(/screen/);
    });
});

describe('@onPress', () => {
    it('reaches a screen-hosted handler only for that screen’s own widgets', async () => {
        const rt = clientWorld();
        hud.open('shop').addScript(Menu as never);
        hud.close('shop');
        hud.open('shop');
        hud.open('pause').addScript(OtherMenu as never);
        hud.close('pause');
        hud.open('pause');

        const shop = [...rt.instances.forHost('screen:shop')][0]!.instance as Menu;
        const pause = [...rt.instances.forHost('screen:pause')][0]!.instance as OtherMenu;

        await pressWidget(rt, { widget: 'back', screen: 'shop' });
        // Two menus with a `back` button do not collide.
        expect(shop.pressed).toStrictEqual(['back']);
        expect(pause.pressed).toStrictEqual([]);
    });

    it('reaches a handler off a screen whatever screen the press named', async () => {
        const rt = clientWorld();
        const player = rt.localPlayer!;
        player.addScript(Shopper as never);
        const shopper = [...rt.instances.forHost('player:p1')][0]!.instance as Shopper;

        await pressWidget(rt, { widget: 'back', screen: 'shop', player });
        await pressWidget(rt, { widget: 'back' });
        expect(shopper.pressed).toStrictEqual(['back', 'back']);
    });
});

describe('the engine log', () => {
    it('reaches the sink the host installed, and keeps its own ring either way', () => {
        // Without a seam every `warn` in the repo is output-less: core writes to no console and
        // holds no transport, so the only reader it can have is the one the host hands it.
        const warnings: string[] = [];
        const stacks: string[] = [];
        const rt = loadGame(
            {},
            {
                log: {
                    warn: (message) => warnings.push(message),
                    error: (record) => stacks.push(record.stack),
                },
            },
        );

        rt.log.warn('a second connection claimed a player id');
        rt.log.error({
            scriptClass: 'C',
            method: 'm',
            hostId: 'game',
            tick: 1,
            event: '@e',
            stack: 'boom',
        });

        expect(warnings).toStrictEqual(['a second connection claimed a player id']);
        expect(stacks).toStrictEqual(['boom']);
        // The bounded ring is unchanged by installing one, and a warning still stays out of it.
        expect(rt.log.records.map((r) => r.stack)).toStrictEqual(['boom']);
    });
});
