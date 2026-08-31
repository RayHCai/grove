// `pointerHit` — the three pointer edges, and the one check core makes before dispatching one.
//
// The entity a hit names is the peer's claim about its own camera and cursor, which no authority
// can recompute: the camera is client state and the cursor never crosses the wire. So the only
// thing checked here is that the entity is still alive, and a handler that grants something is on
// its own for reach — which is a rule worth an assertion precisely because it looks like a gap.

import { describe, it, expect, afterEach } from 'vitest';
import { Pointed } from '../dist/testkit/fixtures.js';
import { joinPlayer, loadGame, pointerHit } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import type { Runtime } from '../src/runtime/runtime.js';
import type { Entity } from '../src/runtime/entity.js';
import { instanceOf } from './helpers.js';

afterEach(() => clearRuntime());

function pointed(rt: Runtime): { entity: Entity; script: Pointed } {
    const entity = rt.wired.gameInstance.spawn('button', 0, 0);
    entity.addScript(Pointed as never);
    return { entity, script: instanceOf<Pointed>(rt, entity, 'Pointed') };
}

describe('the three edges', () => {
    it('each fires only its own handler', async () => {
        const rt = loadGame();
        const { entity, script } = pointed(rt);

        await pointerHit(rt, 'onClick', entity.entityId);
        expect([script.clicks, script.entered, script.exited]).toStrictEqual([1, 0, 0]);

        await pointerHit(rt, 'onHoverEnter', entity.entityId);
        expect([script.clicks, script.entered, script.exited]).toStrictEqual([1, 1, 0]);

        await pointerHit(rt, 'onHoverExit', entity.entityId);
        expect([script.clicks, script.entered, script.exited]).toStrictEqual([1, 1, 1]);
    });

    it('fires at the entity that was hit and no other', async () => {
        const rt = loadGame();
        const a = pointed(rt);
        const b = pointed(rt);

        await pointerHit(rt, 'onClick', a.entity.entityId);
        expect(a.script.clicks).toBe(1);
        expect(b.script.clicks).toBe(0);
    });

    it('reaches every script on the entity, in attachment order', async () => {
        const rt = loadGame();
        const { entity } = pointed(rt);
        entity.addScript(Pointed as never);

        await pointerHit(rt, 'onClick', entity.entityId);
        const both = [...rt.instances.forHost(`entity:${entity.entityId as number}`)];
        expect(both.map((si) => (si.instance as Pointed).clicks)).toStrictEqual([1, 1]);
    });
});

describe('the ctx a hit carries', () => {
    it('names the player when the endpoint supplied one', async () => {
        const rt = loadGame();
        const { entity, script } = pointed(rt);
        const player = joinPlayer(rt, 'p1', 'Ada');

        await pointerHit(rt, 'onClick', entity.entityId, player);
        // Engine-supplied from the connection rather than read off the frame, which is the whole
        // reason a handler may trust it to decide who gets the thing it grants.
        expect(script.lastPlayer).toBe('p1');
        expect(script.sawOther).toBe(false);
    });

    it('falls back to the entity itself when no player is named', async () => {
        const rt = loadGame();
        const { entity, script } = pointed(rt);

        await pointerHit(rt, 'onClick', entity.entityId);
        expect(script.lastPlayer).toBeNull();
        expect(script.sawOther).toBe(true);
    });
});

describe('a hit on a dead entity', () => {
    it('is dropped rather than dispatched', async () => {
        const rt = loadGame();
        const { entity, script } = pointed(rt);
        entity.destroy();
        rt.entityManager.drainDestroyed();

        await pointerHit(rt, 'onClick', entity.entityId);
        expect(script.clicks).toBe(0);
    });

    it('resolves rather than throwing, because the peer is not wrong to have sent it', async () => {
        // The frame the click was drawn against is older than the tick it lands on; an entity that
        // died in between is ordinary, not a protocol error.
        const rt = loadGame();
        const { entity } = pointed(rt);
        entity.destroy();
        rt.entityManager.drainDestroyed();
        await expect(pointerHit(rt, 'onClick', entity.entityId)).resolves.toBeUndefined();
    });

    it('still dispatches to one destroyed this tick, before the drain', async () => {
        // `alive` is the check, and destroy is logical-now: the entity flips dead immediately, so
        // the hit is dropped from that moment rather than at the end of the tick.
        const rt = loadGame();
        const { entity, script } = pointed(rt);
        entity.destroy();
        await pointerHit(rt, 'onClick', entity.entityId);
        expect(script.clicks).toBe(0);
    });
});

describe('the ambient runtime', () => {
    it('is established for the dispatch, so a handler writing HUD state finds this world', async () => {
        // Same reason `pressWidget` establishes it: a press arrives outside a tick, and `hud`
        // resolves the AMBIENT runtime — without this it would land in whichever world loaded last.
        const a = loadGame({ role: 'client' });
        const target = pointed(a);
        loadGame({ role: 'client' }); // a second world is now the ambient one

        await pointerHit(a, 'onClick', target.entity.entityId);
        expect(target.script.clicks).toBe(1);
    });
});
