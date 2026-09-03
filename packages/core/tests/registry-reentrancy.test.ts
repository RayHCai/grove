// A whole-world dispatch walks the instance registry, and attaching is something a handler is
// allowed to do from inside one. These pin that the pass runs against the registry as it stood when
// the pass began: a script attached mid-pass takes its `@onStart` before anything else, and a
// handler that attaches to its own host cannot extend the loop that is dispatching to it.
//
// Both faults are reachable from an untrusted client — `pressWidget` carries a frame's widget name —
// and the second one was a tick that never returned.

import { describe, it, expect, afterEach } from 'vitest';
import { loadGame, pressWidget } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import type { Runtime } from '../src/runtime/runtime.js';
import { Loop } from '../src/loop/loop.js';
import { entityKey } from '../src/runtime/hosts.js';
import type { HandlerDecl } from '../src/script/index.js';
import type { ScriptInstance } from '../src/dispatch/instances.js';

afterEach(() => clearRuntime());

let nextId = 90_000;

/** Stands in for a script class; the dispatcher only ever reads its identity. */
class ProbeClass {
    readonly kind = 'probe';
}

/** A hand-built attachment, so a test can declare exactly the handlers it wants to order. */
function probe(
    rt: Runtime,
    hostKey: string,
    handlers: readonly HandlerDecl[],
    instance: object,
): ScriptInstance {
    return {
        id: nextId++,
        instance,
        klass: ProbeClass,
        className: 'Probe',
        location: 'server',
        handlers,
        hostScopeId: rt.hosts.ensure(hostKey).scopeId,
    };
}

const UPDATE: HandlerDecl = {
    event: '@update',
    kind: 'onUpdate',
    methodName: 'tick',
    opts: { concurrency: 'concurrent' },
};

const START: HandlerDecl = { event: '@start', kind: 'onStart', methodName: 'begin', opts: {} };

const PRESS: HandlerDecl = {
    event: 'go',
    kind: 'onPress',
    methodName: 'press',
    opts: { concurrency: 'concurrent' },
};

describe('the update pass', () => {
    it('runs a script attached from inside it no earlier than its own @onStart', () => {
        const rt = loadGame();
        const loop = new Loop(rt);
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        const hostKey = entityKey(e.entityId as number);
        const order: string[] = [];

        let attached = false;
        rt.instances.attach(
            hostKey,
            probe(rt, hostKey, [UPDATE], {
                tick(): void {
                    if (attached) return;
                    attached = true;
                    rt.instances.attach(
                        hostKey,
                        probe(rt, hostKey, [START, UPDATE], {
                            begin: () => order.push('newborn start'),
                            tick: () => order.push('newborn update'),
                        }),
                    );
                },
            }),
        );

        loop.step(1);
        loop.step(2);

        // A newborn taking the same pass it was attached in would run before the starts pass ever
        // reached it, which is the one order a handler cannot be written against.
        expect(order).toStrictEqual(['newborn start', 'newborn update']);
    });
});

describe('a widget press', () => {
    it('does not dispatch to what the press itself attached', async () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        const hostKey = entityKey(e.entityId as number);
        let presses = 0;

        const attachOne = (): void => {
            rt.instances.attach(
                hostKey,
                probe(rt, hostKey, [PRESS], {
                    press(): void {
                        presses += 1;
                        // Capped so the fault is a wrong count rather than a test that never ends:
                        // over the live registry this loop grew by one entry per dispatch.
                        if (presses < 50) attachOne();
                    },
                }),
            );
        };
        attachOne();

        await pressWidget(rt, { widget: 'go' });

        expect(presses).toBe(1);
        // The one it attached is still queued for the starts pass, not consumed by this press.
        expect(rt.instances.pendingStartCount).toBe(2);
    });
});
