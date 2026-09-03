// What attaching does: inject the inspector's props, and queue the @onStart the pass order drains.

import { afterEach, describe, expect, it } from 'vitest';
import type { ScriptId, TemplateId } from '@platform/project';
import {
    Configured,
    FaultyMovement,
    Greeter,
    LateJoiner,
    RivalWallet,
    Roll,
    ShadowsGameGetter,
    ShadowsGameMethod,
    ShadowsPlayerField,
    ShadowsPlayerGetter,
    SyncedRoster,
    TickOverridingMovement,
    Viewfinder,
    Wallet,
} from '../dist/testkit/fixtures.js';
import { LoadError } from '../src/errors.js';
import { Loop } from '../src/loop/loop.js';
import { joinPlayer, loadGame, startGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import { entityKey, playerKey } from '../src/runtime/hosts.js';
import type { TemplateDef } from '../src/world/templates.js';

afterEach(() => clearRuntime());

/** Yields a macrotask, which drains every microtask a dispatch's promise chain queues behind it. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function instanceOn(rt: ReturnType<typeof loadGame>, hostKey: string, at = 0): object {
    return rt.instances.forHost(hostKey)[at]!.instance;
}

describe('constructor props', () => {
    it('reach the constructor, so a class can derive from what it was configured with', () => {
        const rt = loadGame();
        const crate = rt.wired.gameInstance.spawn('crate', 0, 0);
        crate.addScript(Configured as never, { speed: 9 });

        const instance = instanceOn(rt, entityKey(crate.entityId as number)) as {
            configuredKeys: string[];
        };
        expect(instance.configuredKeys).toStrictEqual(['speed']);
    });

    it('land BEFORE the hoist, so an inspector value beats the field initializer', () => {
        const rt = loadGame();
        const crate = rt.wired.gameInstance.spawn('crate', 0, 0);
        crate.addScript(Configured as never, { speed: 9 });

        // The host record is what replication reads and what `entity.speed` resolves through, so
        // this is the assertion that catches a prop written after the hoist: the record would hold
        // the initializer's 1 while the instance held 9, and the wire would carry 1 forever.
        const record = rt.hosts.get(entityKey(crate.entityId as number))!.record;
        expect(record.values.get('speed')).toBe(9);
        expect((crate as unknown as { speed: number }).speed).toBe(9);
    });

    it('leave a field the props do not name at its initializer', () => {
        const rt = loadGame();
        const crate = rt.wired.gameInstance.spawn('crate', 0, 0);
        crate.addScript(Configured as never, { speed: 9 });
        expect((crate as unknown as { label: string }).label).toBe('default');
    });

    it('are optional, so a class attached with none is exactly what it was before', () => {
        const rt = loadGame();
        const crate = rt.wired.gameInstance.spawn('crate', 0, 0);
        crate.addScript(Configured as never);
        expect((crate as unknown as { speed: number }).speed).toBe(1);
        expect(
            (instanceOn(rt, entityKey(crate.entityId as number)) as { configuredKeys: string[] })
                .configuredKeys,
        ).toStrictEqual([]);
    });

    it('never write a reserved key, which would rewrite the instance rather than a field', () => {
        const rt = loadGame();
        const crate = rt.wired.gameInstance.spawn('crate', 0, 0);
        const hostile = JSON.parse('{"__proto__": {"owned": true}, "speed": 4}') as Record<
            string,
            never
        >;
        crate.addScript(Configured as never, hostile);

        const instance = instanceOn(rt, entityKey(crate.entityId as number));
        expect((instance as { owned?: boolean }).owned).toBeUndefined();
        // The rest of the map still applies: one refused key is not a refused attachment.
        expect((crate as unknown as { speed: number }).speed).toBe(4);
    });

    it('ride a template attachment, so every instance of it is configured the same way', () => {
        const templates: TemplateDef[] = [
            {
                id: 'turret' as TemplateId,
                scripts: [
                    {
                        script: 'configured' as ScriptId,
                        klass: Configured as never,
                        props: { speed: 7 },
                    },
                ],
                children: [],
            },
        ];
        const rt = loadGame({ templates });
        const turret = rt.wired.gameInstance.spawn('turret', 0, 0);
        expect((turret as unknown as { speed: number }).speed).toBe(7);
    });
});

describe('@onStart is deferred to a pass, not fired at the attach', () => {
    it('runs for a script `addScript` attached from a player-join handler', async () => {
        const rt = loadGame({ gameScripts: [Greeter as never] });
        await startGame(rt);

        const player = joinPlayer(rt, 'p1', 'Ada');
        const greeted = (): boolean => (player as unknown as { greeted: boolean }).greeted;
        // The join handler ran outside any tick, so nothing has started the new script: firing
        // there would have run it against whatever tick the loop last adopted.
        expect(greeted()).toBe(false);
        expect(rt.instances.pendingStartCount).toBe(1);

        new Loop(rt).step(1);
        await settle();
        expect(greeted()).toBe(true);
        expect(rt.instances.pendingStartCount).toBe(0);
    });

    it('runs once, however many ticks follow', async () => {
        const rt = loadGame({ gameScripts: [Greeter as never] });
        await startGame(rt);
        joinPlayer(rt, 'p1', 'Ada');

        const loop = new Loop(rt);
        loop.step(1);
        await settle();
        const instance = instanceOn(rt, playerKey('p1')) as { greeted: boolean };
        instance.greeted = false;
        loop.step(2);
        await settle();
        // The drain empties the queue, so a second tick has nothing to spend.
        expect(instance.greeted).toBe(false);
    });

    it('never runs for a script whose host was torn down before the drain', async () => {
        const rt = loadGame();
        const crate = rt.wired.gameInstance.spawn('crate', 0, 0);
        crate.addScript(LateJoiner as never);
        expect(rt.instances.pendingStartCount).toBe(1);

        crate.destroy();
        rt.entityManager.drainDestroyed();
        // Dropped with the host: the destroy drain has already run `@onEnd` there, and starting
        // after ending is the one order a handler cannot be written against.
        expect(rt.instances.pendingStartCount).toBe(0);

        new Loop(rt).step(1);
        await settle();
        expect([...rt.instances.all()]).toHaveLength(0);
    });

    it('is the first pass, so a script is running before anything dispatches to it', async () => {
        const rt = loadGame();
        const order: string[] = [];
        const passes = rt.wired.passes;
        rt.wired.passes = {
            ...passes,
            starts: (dispatch) => {
                order.push('starts');
                passes.starts(dispatch);
            },
            input: (dispatch) => {
                order.push('input');
                passes.input(dispatch);
            },
        };
        new Loop(rt).step(1);
        await settle();
        expect(order).toStrictEqual(['starts', 'input']);
    });
});

describe('startGame drains the first batch', () => {
    it('starts what loadGame attached, before the loop has stepped at all', async () => {
        const rt = loadGame({ gameScripts: [Greeter as never] });
        // Wired and hoisted, not started: a Game `@onStart` must see a built world.
        expect(rt.instances.pendingStartCount).toBe(1);
        await startGame(rt);
        expect(rt.instances.pendingStartCount).toBe(0);
    });
});

// Every rejection is a LoadError rather than a logged warning: a half-hoisted host record matches
// no declaration, so continuing past one leaves a world whose scripts silently never fire.
describe('wire-time rejections', () => {
    it('refuses a SyncedScript on a camera host, which has no authoritative copy', () => {
        const rt = loadGame({ role: 'client' });
        const player = joinPlayer(rt, 'p1', 'Ada');
        expect(() => player.camera.addScript(Viewfinder as never)).toThrow(LoadError);
        expect(() => player.camera.addScript(Viewfinder as never)).toThrow(/camera/);
    });

    it('refuses a roster handler off a Game host', () => {
        // `ctx.player` on a join is the roster's business, and an entity-hosted copy would fire
        // once per entity for every join in the world.
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        expect(() => e.addScript(Roll as never)).toThrow(/@onPlayerJoin/);
    });

    it('refuses a roster handler off a ServerScript, even on the Game host', () => {
        const rt = loadGame();
        expect(() => rt.wired.gameInstance.addScript(SyncedRoster as never)).toThrow(
            /@onPlayerJoin/,
        );
    });

    it('refuses two @serverState fields claiming one name on a host', () => {
        // The record is one map: the second hoist would overwrite the first class's value and both
        // scripts would then be writing through one another.
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.addScript(Wallet as never);
        expect(() => e.addScript(RivalWallet as never)).toThrow(LoadError);
        expect(() => e.addScript(RivalWallet as never)).toThrow(/credits/);
    });

    it('refuses a @serverState name the Game already answers to as a getter', () => {
        // Hoisted, it would REPLACE the roster getter with a number, and the first
        // `game.players.filter(...)` would throw a TypeError nowhere near the declaration.
        const rt = loadGame();
        expect(() => rt.wired.gameInstance.addScript(ShadowsGameGetter as never)).toThrow(
            LoadError,
        );
        expect(() => rt.wired.gameInstance.addScript(ShadowsGameGetter as never)).toThrow(
            /players/,
        );
        expect(Array.isArray(rt.wired.gameInstance.players)).toBe(true);
    });

    it('refuses one the Game answers to as a method', () => {
        const rt = loadGame();
        expect(() => rt.wired.gameInstance.addScript(ShadowsGameMethod as never)).toThrow(/spawn/);
        expect(typeof rt.wired.gameInstance.spawn).toBe('function');
    });

    it('refuses a Player getter name, which would shadow it', () => {
        const rt = loadGame();
        const player = joinPlayer(rt, 'p1', 'Ada');
        expect(() => player.addScript(ShadowsPlayerGetter as never)).toThrow(/avatar/);
    });

    it('refuses a Player OWN field name, which would silently split one name across two values', () => {
        // The failure this catches is not a shadow: the hoist skips an own property, so `this.name`
        // would read the host record while `player.name` kept the engine's.
        const rt = loadGame();
        const player = joinPlayer(rt, 'p1', 'Ada');
        expect(() => player.addScript(ShadowsPlayerField as never)).toThrow(/name/);
        expect(player.name).toBe('Ada');
    });

    it('lets one class declare a name a DIFFERENT host already uses', () => {
        const rt = loadGame();
        const a = rt.wired.gameInstance.spawn('crate', 0, 0);
        const b = rt.wired.gameInstance.spawn('crate', 0, 0);
        a.addScript(Wallet as never);
        expect(() => b.addScript(Wallet as never)).not.toThrow();
    });

    it('refuses a movement class that overrides tick', () => {
        // The stage order in `tick` is the contract both endpoints replay, so an override is a
        // desync rather than a customisation — and the message names the hooks that are not.
        const rt = loadGame();
        const player = joinPlayer(rt, 'p1', 'Ada');
        player.spawn();
        expect(() => player.setMovement(TickOverridingMovement as never)).toThrow(
            /overrides tick\(\)/,
        );
        expect(() => player.setMovement(TickOverridingMovement as never)).toThrow(/accelerate/);
    });

    it('allows a movement class that overrides only the stages it may', () => {
        const rt = loadGame();
        const player = joinPlayer(rt, 'p1', 'Ada');
        player.spawn();
        expect(() => player.setMovement(FaultyMovement as never)).not.toThrow();
    });
});

describe('persisted seeding', () => {
    it('prefers a stored value over the field initializer', () => {
        const rt = loadGame();
        rt.persisted = stored({ credits: 500 });
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.addScript(Wallet as never);
        expect((e as unknown as { credits: number }).credits).toBe(500);
    });

    it('discards a stored value whose type no longer matches the declaration', () => {
        // A creator who changed `credits` from a number to something else gets the new
        // initializer, not last week's number arriving where a string is now expected.
        const rt = loadGame();
        rt.persisted = stored({ credits: 'five hundred' });
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.addScript(Wallet as never);
        expect((e as unknown as { credits: number }).credits).toBe(10);
    });

    it('seeds each field independently', () => {
        const rt = loadGame();
        rt.persisted = stored({ credits: 7, label: 42 });
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.addScript(Wallet as never);
        expect((e as unknown as { credits: number }).credits).toBe(7);
        expect((e as unknown as { label: string }).label).toBe('anon'); // tag mismatch, discarded
    });
});

/** A `PersistedSource` holding one bag of values for every host that asks. */
function stored(values: Record<string, unknown>): { get(hostId: string, field: string): unknown } {
    return { get: (_hostId, field) => values[field] };
}
