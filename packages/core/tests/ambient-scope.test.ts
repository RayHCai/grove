import { describe, it, expect, afterEach } from 'vitest';
import { loadGame } from '../src/runtime/load-game.js';
import { clearRuntime, currentRuntime, withRuntime } from '../src/runtime/runtime.js';
import type { Runtime } from '../src/runtime/runtime.js';
import { setScriptRuntime } from '../src/runtime/script-runtime.js';
import { game } from '../src/runtime/game.js';
import { Loop } from '../src/loop/loop.js';
import { entityKey } from '../src/runtime/hosts.js';
import { after, every, sleep } from '../src/runtime/time.js';
import type { HandlerDecl } from '../src/script/index.js';
import type { ScriptInstance } from '../src/dispatch/instances.js';
import type { Entity } from '../src/runtime/entity.js';

afterEach(() => clearRuntime());

let nextId = 91_000;

/** Stands in for a script class; the dispatcher only ever reads its identity. */
class ProbeClass {
    readonly kind = 'probe';
}

const START: HandlerDecl = { event: '@start', kind: 'onStart', methodName: 'begin', opts: {} };

/** Attaches `begin` to `entity` as its `@onStart`, and answers the entity's host scope. */
function onStart(rt: Runtime, entity: Entity, begin: () => unknown): number {
    const hostKey = entityKey(entity.entityId as number);
    const hostScopeId = rt.hosts.ensure(hostKey).scopeId;
    const instance = { begin };
    // What wiring does at every attach, and what a continuation finds its world through.
    setScriptRuntime(instance, rt);
    const inst: ScriptInstance = {
        id: nextId++,
        instance,
        klass: ProbeClass,
        className: 'Probe',
        location: 'server',
        handlers: [START],
        hostScopeId,
    };
    rt.instances.attach(hostKey, inst);
    return hostScopeId;
}

/** Lets every parked continuation run; the heaps resolve promises, they do not await them. */
function drainMicrotasks(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('a timer registered past an await', () => {
    it('belongs to the host that awaited, so its teardown takes the timer', async () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        onStart(rt, e, async () => {
            await sleep(1 / rt.simRate);
            every(1 / rt.simRate, () => {});
        });

        loop.step(1);
        loop.step(2);
        await drainMicrotasks();
        expect(rt.timers.pendingCount).toBe(1);

        e.destroy();
        loop.step(3);
        // Zero, not one: an await that lost the invocation registered this on no host at all, and a
        // hostless timer is nobody's to cancel; it kept firing through a released slot.
        expect(rt.timers.pendingCount).toBe(0);
    });
});

describe('a timer registered inside a timer callback', () => {
    it('inherits its own host, not whichever invocation settled last', async () => {
        const rt = loadGame();
        const loop = new Loop(rt);

        // Settles between ticks, which is what used to leave a finished invocation ambient.
        const parked = rt.wired.gameInstance.spawn('crate', 0, 0);
        const parkedScope = onStart(rt, parked, async () => {
            await sleep(1 / rt.simRate);
        });

        const owner = rt.wired.gameInstance.spawn('crate', 1, 0);
        const ownerScope = onStart(rt, owner, () => {
            after(2 / rt.simRate, () => {
                every(1 / rt.simRate, () => {});
            });
        });
        expect(parkedScope).not.toBe(ownerScope);

        loop.step(1);
        loop.step(2);
        await drainMicrotasks();
        loop.step(3);
        expect(rt.timers.pendingCount).toBe(1);

        parked.destroy();
        loop.step(4);
        // The other host's teardown reaches nothing of this one's: the callback ran with no
        // invocation of its own, so it used to charge its timer to whoever settled last.
        expect(rt.timers.pendingCount).toBe(1);

        owner.destroy();
        loop.step(5);
        expect(rt.timers.pendingCount).toBe(0);
    });
});

describe('a continuation in a process holding two worlds', () => {
    it('resumes in the world that awaited, not the one loaded last', async () => {
        const server = loadGame();
        const loop = new Loop(server);
        const host = server.wired.gameInstance.spawn('crate', 0, 0);
        onStart(server, host, async () => {
            await sleep(1 / server.simRate);
            game.spawn('gift', 5, 5);
            every(1 / server.simRate, () => {});
        });
        // A second world in the realm, as a preview holds a mirror beside its authority.
        const mirror = loadGame({ role: 'client' });

        loop.step(1);
        loop.step(2);
        await drainMicrotasks();

        expect(server.entities.liveIds()).toHaveLength(2);
        expect(server.timers.pendingCount).toBe(1);
        expect(mirror.entities.liveIds()).toHaveLength(0);
        expect(mirror.timers.pendingCount).toBe(0);
    });

    it('yields to withRuntime, which names its world outright', async () => {
        const server = loadGame();
        const loop = new Loop(server);
        const host = server.wired.gameInstance.spawn('crate', 0, 0);
        const seen: Runtime[] = [];
        onStart(server, host, async () => {
            await sleep(1 / server.simRate);
            seen.push(currentRuntime());
            seen.push(withRuntime(mirror, () => currentRuntime()));
            seen.push(currentRuntime());
        });
        const mirror = loadGame({ role: 'client' });

        loop.step(1);
        loop.step(2);
        await drainMicrotasks();

        expect(seen).toEqual([server, mirror, server]);
        // Settled, so nothing of the server's invocation is left to outrank the slot.
        expect(currentRuntime()).toBe(mirror);
    });
});
