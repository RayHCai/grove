// The module-const facades, and the rule that makes them safe: everything they need lives on the
// runtime and is resolved per call.
//
// `game`, `assets`, `hud`, `random` are consts a creator imports once at the top of a file. If any
// of them captured a runtime — in a module slot, a closure, a cached reference — a second
// `loadGame` in the same process would leave the first world's scripts writing into the second's.
// One page holds one client and hides that entirely; a test process, an editor preview and a
// server-plus-two-clients harness all do not.

import { describe, it, expect, afterEach } from 'vitest';
import { bounds } from '@platform/math';
import { Asset, AssetRegistry, assets } from '../src/runtime/assets.js';
import { music, sound } from '../src/runtime/audio.js';
import { Camera } from '../src/runtime/camera.js';
import { Storage } from '../src/runtime/wrappers.js';
import { hoistReplicated } from '../src/state/backing.js';
import { createHostRecord } from '../src/state/host-record.js';
import { MemoryKVStore } from '../src/runtime/seams.js';
import { orbit, oscillate } from '../src/runtime/motion.js';
import { game } from '../src/runtime/game.js';
import { joinPlayer, loadGame } from '../src/runtime/load-game.js';
import { clearRuntime, createRuntime, hasRuntime, withRuntime } from '../src/runtime/runtime.js';
import { Loop } from '../src/loop/loop.js';
import { entityKey } from '../src/runtime/hosts.js';

afterEach(() => clearRuntime());

const WORLD = bounds(-1000, 1000, 1000, -1000);

describe('the runtime slot', () => {
    it('reports whether one is active', () => {
        expect(hasRuntime()).toBe(false);
        loadGame();
        expect(hasRuntime()).toBe(true);
        clearRuntime();
        expect(hasRuntime()).toBe(false);
    });

    it('withRuntime restores the previous slot, even when the body throws', () => {
        const first = loadGame();
        const second = createRuntime();
        clearRuntime();
        // Deliberately no ambient runtime: `withRuntime` must put back what it found, including
        // nothing, or a nested call would leak the inner world to everything after it.
        expect(() =>
            withRuntime(second, () => {
                throw new Error('body always throws');
            }),
        ).toThrow();
        expect(hasRuntime()).toBe(false);

        withRuntime(first, () => {
            expect(hasRuntime()).toBe(true);
        });
        expect(hasRuntime()).toBe(false);
    });

    it('nests', () => {
        const outer = loadGame({ bounds: WORLD });
        const inner = loadGame({ bounds: WORLD });
        outer.wired.gameInstance.spawn('crate', 0, 0);
        clearRuntime();

        withRuntime(outer, () => {
            expect(game.entities).toHaveLength(1);
            withRuntime(inner, () => {
                expect(game.entities).toHaveLength(0);
            });
            // Back to the outer world rather than to whatever loaded last.
            expect(game.entities).toHaveLength(1);
        });
    });

    it('a runtime built bare says so rather than no-opping', () => {
        // A store-level test builds one of these; reaching for a collaborator `loadGame` would have
        // installed is a mistake worth a message, not a silently empty world.
        const bare = createRuntime();
        expect(() => bare.wired).toThrow(/not loaded/);
        expect(bare.wiredOrNull).toBeNull();
    });
});

describe('the game const', () => {
    it('follows the runtime rather than the world it was first read in', () => {
        const first = loadGame({ bounds: WORLD });
        first.wired.gameInstance.spawn('crate', 0, 0);
        expect(game.entities).toHaveLength(1);

        loadGame({ bounds: WORLD }); // a second world is now current
        expect(game.entities).toHaveLength(0);

        withRuntime(first, () => {
            expect(game.entities).toHaveLength(1);
        });
    });

    it('hands back methods unbound, so a method read off it does not capture a world', () => {
        const first = loadGame({ bounds: WORLD });
        const fromFirst = game.spawn;
        const second = loadGame({ bounds: WORLD });
        const fromSecond = game.spawn;

        // The same prototype function both times — a BOUND copy would be a different object each
        // read and would pin the world it was read from.
        expect(fromFirst).toBe(fromSecond);

        // And `this` on a `game.spawn(...)` call is the proxy, so it resolves again through the
        // current runtime rather than through whichever world the method came off.
        game.spawn('crate', 0, 0);
        expect(second.entities.liveIds()).toHaveLength(1);
        expect(first.entities.liveIds()).toHaveLength(0);
    });
});

describe('assets', () => {
    it('answers what the manifest declared, by key and by kind', () => {
        loadGame({
            assets: [
                { key: 'coin', kind: 'texture', meta: { width: 16, height: 16 } },
                { key: 'chime', kind: 'audio', meta: { duration: 2 } },
            ],
        });

        expect(assets.get('coin')?.kind).toBe('texture');
        expect(assets.get('coin')?.width).toBe(16);
        expect(assets.get('chime')?.duration).toBe(2);
        expect(assets.all('texture').map((a) => a.key)).toStrictEqual(['coin']);
        expect(assets.all()).toHaveLength(2);
    });

    it('answers null for a key nothing declared', () => {
        loadGame();
        expect(assets.get('missing')).toBeNull();
    });

    it('is empty rather than throwing with no runtime at all', () => {
        // A creator module reading `assets.all()` at import time runs before any world exists.
        expect(assets.all()).toStrictEqual([]);
        expect(assets.get('coin')).toBeNull();
    });

    it('resolves per call, so a second loadGame does not repoint the first world’s table', () => {
        const first = loadGame({ assets: [{ key: 'coin', kind: 'texture' }] });
        loadGame({ assets: [{ key: 'gem', kind: 'texture' }] });

        expect(assets.get('coin')).toBeNull();
        withRuntime(first, () => {
            expect(assets.get('coin')?.key).toBe('coin');
            expect(assets.get('gem')).toBeNull();
        });
    });

    it('the registry itself holds whatever is defined on it', () => {
        const registry = new AssetRegistry();
        registry.define(new Asset('font', 'font'));
        registry.define(new Asset('clip', 'clip', { duration: 3 }));
        expect(registry.all('clip').map((a) => a.key)).toStrictEqual(['clip']);
        // Declared means present: core loads nothing, so `loaded` is what the manifest asserted.
        expect(registry.get('font')?.loaded).toBe(true);
        expect(registry.get('font')?.width).toBe(0);
    });
});

describe('sound and music', () => {
    it('reach the effect sink and hand back an inert handle', () => {
        // Playback is the client's; core's job is to say that it happened, which is what makes the
        // whole audio surface exercisable in Node.
        const rt = loadGame();
        const played: string[] = [];
        rt.effects = { play: (kind: string) => played.push(kind) };

        const handle = sound.play('chime');
        sound.stopAll();
        music.play('theme');
        music.stop(0.5);

        expect(played).toStrictEqual(['sound.play', 'sound.stopAll', 'music.play', 'music.stop']);
        expect(() => handle.stop()).not.toThrow();
        expect(handle.volume).toBe(1);
    });

    it('is a no-op with no runtime, rather than throwing at import time', () => {
        expect(() => sound.play('chime')).not.toThrow();
        expect(() => music.stop()).not.toThrow();
    });
});

describe('Camera', () => {
    it('is presentation-only: nothing it holds is captured or marked', () => {
        const rt = loadGame({ bounds: WORLD });
        const loop = new Loop(rt);
        const player = joinPlayer(rt, 'p1', 'Ada');
        rt.channels.drainStructural();

        const snap = loop.snapshot();
        player.camera.moveTo(100, 50).follow(null);
        player.camera.zoom = 2;
        loop.restore(snap);

        // Survived the rewind, because no store holds it — camera state is the client's to draw.
        expect(player.camera.position).toEqual({ x: 100, y: 50, z: 0 });
        expect(player.camera.zoom).toBe(2);
        expect(rt.channels.structuralCount).toBe(0);
        expect(rt.channels.stateCount).toBe(0);
    });

    it('is one per player, made once and kept', () => {
        const rt = loadGame();
        const player = joinPlayer(rt, 'p1', 'Ada');
        expect(player.camera).toBe(player.camera);
        expect(player.camera).toBeInstanceOf(Camera);
        expect(player.camera.player).toBe(player);
    });

    it('shake reaches the effect sink for that player', () => {
        const rt = loadGame();
        const player = joinPlayer(rt, 'p1', 'Ada');
        const played: Array<[string, unknown]> = [];
        rt.effects = { play: (kind: string, payload?: unknown) => played.push([kind, payload]) };

        player.camera.shake(5, 0.3);
        expect(played).toStrictEqual([['camera.shake', { player: 'p1' }]]);
    });

    it('follow and moveTo chain, and glide/zoom resolve', async () => {
        const rt = loadGame();
        const player = joinPlayer(rt, 'p1', 'Ada');
        const camera = player.camera;
        expect(camera.follow(null).moveTo(1, 2)).toBe(camera);
        await expect(camera.glideTo(10, 20, 1)).resolves.toBeUndefined();
        await expect(camera.zoomTo(3, 1)).resolves.toBeUndefined();
        expect(camera.position).toEqual({ x: 10, y: 20, z: 0 });
        expect(camera.zoom).toBe(3);
    });
});

describe('Storage', () => {
    it('scopes every key to the player it was made for', async () => {
        const kv = new MemoryKVStore();
        const mine = new Storage(kv, 'player:a');
        const theirs = new Storage(kv, 'player:b');

        await mine.set('bag', ['sword']);
        expect(await mine.get('bag')).toStrictEqual(['sword']);
        // The scope IS the isolation: one KV behind every player, so a shared key would leak saves.
        expect(await theirs.get('bag')).toBeUndefined();

        await mine.delete('bag');
        expect(await mine.get('bag')).toBeUndefined();
    });

    it('is one per player, made once and kept', () => {
        const rt = loadGame();
        const player = joinPlayer(rt, 'p1', 'Ada');
        expect(player.storage).toBe(player.storage);
        expect(player.storage).toBeInstanceOf(Storage);
    });
});

describe('hoistReplicated', () => {
    it('lets a receiver running no scripts read a replicated field by name', () => {
        // The mirror's half of `@serverState`. Wiring installs the pair from an instance; a client
        // running no scripts has none, so the value would arrive in the record and stop there —
        // `game.phase` would read undefined on the machine that draws it.
        const record = createHostRecord('game');
        const host = {} as Record<string, unknown>;
        record.values.set('phase', 'lobby');
        hoistReplicated(host, 'phase', record.values);

        expect(host['phase']).toBe('lobby');
        record.values.set('phase', 'arena');
        expect(host['phase']).toBe('arena'); // reads through, never a copy
    });

    it('is read-only, because there is no authority behind a local write', () => {
        const record = createHostRecord('game');
        const host = {} as Record<string, unknown>;
        record.values.set('phase', 'lobby');
        hoistReplicated(host, 'phase', record.values);

        // A write here would be a local lie the next envelope silently overwrites, so the accessor
        // defines no setter at all.
        expect(Object.getOwnPropertyDescriptor(host, 'phase')?.set).toBeUndefined();
        expect(record.values.get('phase')).toBe('lobby');
    });

    it('leaves a property the host already owns alone', () => {
        const record = createHostRecord('game');
        const host: Record<string, unknown> = { phase: 'mine' };
        record.values.set('phase', 'theirs');
        hoistReplicated(host, 'phase', record.values);
        expect(host['phase']).toBe('mine');
    });
});

describe('oscillate and orbit', () => {
    it('oscillate returns the entity to its base over one period', () => {
        const rt = loadGame({ bounds: WORLD, simRate: 60 });
        const loop = new Loop(rt);
        const e = rt.wired.gameInstance.spawn('crate', 100, 0);

        oscillate(e, 'x', 10, 1); // ±10 about x=100, one second
        loop.step(1);
        expect(e.position.x).toBeGreaterThan(100);

        for (let t = 2; t <= 60; t++) loop.step(t);
        expect(e.position.x).toBeCloseTo(100, 6);
        expect(e.position.y).toBe(0); // the other axis is untouched
    });

    it('orbit holds the radius about its centre', () => {
        const rt = loadGame({ bounds: WORLD, simRate: 60 });
        const loop = new Loop(rt);
        const e = rt.wired.gameInstance.spawn('moon', 0, 0);

        orbit(e, { x: 100, y: 100, z: 0 }, 50, Math.PI);
        for (let t = 1; t <= 30; t++) {
            loop.step(t);
            const dx = e.position.x - 100;
            const dy = e.position.y - 100;
            expect(Math.sqrt(dx * dx + dy * dy)).toBeCloseTo(50, 6);
        }
    });

    it('orbits about another entity’s position, read once at the call', () => {
        const rt = loadGame({ bounds: WORLD, simRate: 60 });
        const loop = new Loop(rt);
        const centre = rt.wired.gameInstance.spawn('planet', 200, 0);
        const moon = rt.wired.gameInstance.spawn('moon', 0, 0);

        orbit(moon, centre, 10, Math.PI);
        loop.step(1);
        // The centre is the OTHER entity's position, read once when orbit was called — so the moon
        // circles (200, 0) rather than the origin it was spawned at.
        expect(Math.hypot(moon.position.x - 200, moon.position.y)).toBeCloseTo(10, 6);
        expect(moon.position.x).toBeGreaterThan(200);
    });

    it('the ANIMATED entity owns the timer, so its destroy stops the writes', () => {
        // Not the caller's host: `oscillate(other)` from a Game handler used to leave a timer that
        // outlived `other` and kept writing to whatever entity took its slot.
        const rt = loadGame({ bounds: WORLD, simRate: 60 });
        const loop = new Loop(rt);
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        rt.hosts.ensure(entityKey(e.entityId as number));

        oscillate(e, 'y', 10, 1);
        loop.step(1);
        expect(rt.timers.pendingCount).toBe(1);

        e.destroy();
        loop.step(2);
        expect(rt.timers.pendingCount).toBe(0);
    });
});
