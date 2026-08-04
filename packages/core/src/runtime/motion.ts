// Motion helpers (DESIGN §11, api_spec.ts:1042). oscillate/orbit are the engine lifecycle
// (an every-tick timer, cancelled with the host) wrapped around a pure curve from math;
// tween is the shared implementation escape hatch (§9.1) — here it drives an arbitrary
// object's numeric props through the tween engine.

import type { Easing } from '@platform/math';
import { cos, sin } from '@platform/math';
import type { Entity } from './entity.js';
import type { Camera } from './camera.js';
import type { Vec3 } from '@platform/math';
import { currentRuntime } from './runtime.js';
import { currentInvocation } from '../dispatch/ambient.js';
import type { TweenTarget } from '../loop/tweens.js';

function hostScope(): number {
    return currentInvocation()?.hostId ?? -1;
}

export function oscillate(entity: Entity, axis: 'x' | 'y', amount: number, seconds: number): void {
    const rt = currentRuntime();
    const base = axis === 'x' ? entity.position.x : entity.position.y;
    let t = 0;
    const dt = 1 / rt.simRate;
    rt.timers.every(dt, hostScope(), () => {
        t += dt;
        const offset = sin((t / seconds) * 2 * Math.PI) * amount;
        if (axis === 'x') entity.setPosition(base + offset, entity.position.y);
        else entity.setPosition(entity.position.x, base + offset);
    });
}

export function orbit(entity: Entity, center: Entity | Vec3, radius: number, speed: number): void {
    const rt = currentRuntime();
    const c = 'position' in center ? center.position : center;
    let angle = 0;
    const dt = 1 / rt.simRate;
    rt.timers.every(dt, hostScope(), () => {
        angle += speed * dt;
        entity.setPosition(c.x + cos(angle) * radius, c.y + sin(angle) * radius);
    });
}

/** The advanced escape hatch (§9.1): animate arbitrary numeric props on a target. */
export function tween(
    target: Entity | Camera | object,
    props: Record<string, number>,
    seconds: number,
    easing?: Easing,
): Promise<void> {
    const rt = currentRuntime();
    const t = asTweenTarget(target);
    const scope = hostScope();
    return Promise.all(
        Object.entries(props).map(([prop, to]) => rt.tweens.start(t, prop, to, seconds, scope, easing)),
    ).then(() => undefined);
}

/** Adapts a plain object to the tween interface — its own numeric properties. */
function asTweenTarget(target: object): TweenTarget {
    const obj = target as Record<string, number>;
    return {
        key: `object:${objectId(target)}`,
        get: prop => obj[prop] ?? 0,
        set: (prop, value) => {
            obj[prop] = value;
        },
    };
}

const ids = new WeakMap<object, number>();
let nextObjectId = 1;
function objectId(o: object): number {
    let id = ids.get(o);
    if (id === undefined) {
        id = nextObjectId++;
        ids.set(o, id);
    }
    return id;
}
