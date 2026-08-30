// The one TransformView factory over the live stores, and the half-extent function that is the
// only thing its two callers disagree about.

import { describe, it, expect, afterEach } from 'vitest';
import { bounds } from '@platform/math';
import type { EntityId } from '../src/ids.js';
import { loadGame } from '../src/runtime/load-game.js';
import { clearRuntime } from '../src/runtime/runtime.js';
import { liveTransformView } from '../src/runtime/transform-view.js';

afterEach(() => clearRuntime());

describe('liveTransformView', () => {
    it('reads positions and live ids off the live stores', () => {
        const rt = loadGame();
        const a = rt.wired.gameInstance.spawn('crate', 10, 20);
        const b = rt.wired.gameInstance.spawn('crate', -3, 4);
        const view = liveTransformView(rt);

        expect(view.posX(a.entityId)).toBe(10);
        expect(view.posY(a.entityId)).toBe(20);
        expect(view.liveIds()).toEqual([a.entityId, b.entityId]);
    });

    it('refills the array it is handed rather than allocating', () => {
        const rt = loadGame();
        rt.wired.gameInstance.spawn('crate', 0, 0);
        const view = liveTransformView(rt);
        const out: EntityId[] = [];

        expect(view.liveIds(out)).toBe(out);
        expect(out).toHaveLength(1);
        expect(view.liveIds(out)).toHaveLength(1); // refilled, not appended to
    });

    it('treats every entity as a point when no half-extent function is given', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        e.collider = { enabled: true, isTrigger: false, bounds: bounds(-20, 20, 4, -4) };
        const view = liveTransformView(rt);

        expect(view.halfWidth(e.entityId)).toBe(0);
        expect(view.halfHeight(e.entityId)).toBe(0);
    });

    it('asks the supplied function per axis', () => {
        const rt = loadGame();
        const e = rt.wired.gameInstance.spawn('crate', 0, 0);
        const view = liveTransformView(rt, (_id, axis) => (axis === 'w' ? 7 : 3));

        expect(view.halfWidth(e.entityId)).toBe(7);
        expect(view.halfHeight(e.entityId)).toBe(3);
    });
});
