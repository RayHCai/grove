// oscillate/orbit are an every-tick timer around a pure curve from math, so they stop when
// their owning host dies rather than carrying their own cancel handle.

import type { Easing } from '@platform/math';
import { cos, sin } from '@platform/math';
import type { Entity } from './entity.js';
import type { Camera } from './camera.js';
import type { Vec3 } from '@platform/math';
import { currentRuntime } from './runtime.js';
import type { Runtime } from './runtime.js';
import { NO_SCOPE } from '../dispatch/scope-tree.js';
import { currentInvocation } from '../dispatch/ambient.js';
import type { TweenTarget } from '../loop/tweens.js';

// The animated entity owns the timer, not the caller: `oscillate(other)` from a Game handler used
// to leave a timer that outlived `other` and kept writing to its released slot.
function entityScope(rt: Runtime, entity: Entity): number {
    const own = rt.hosts.scopeForEntity(entity.entityId as unknown as number);
    if (own !== NO_SCOPE) return own;
    return currentInvocation()?.hostId ?? NO_SCOPE;
}

export function oscillate(entity: Entity, axis: 'x' | 'y', amount: number, seconds: number): void {
    const rt = currentRuntime();
    const base = axis === 'x' ? entity.position.x : entity.position.y;
    let t = 0;
    const dt = 1 / rt.simRate;
    rt.timers.every(dt, entityScope(rt, entity), () => {
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
    rt.timers.every(dt, entityScope(rt, entity), () => {
        angle += speed * dt;
        entity.setPosition(c.x + cos(angle) * radius, c.y + sin(angle) * radius);
    });
}

/** Animates arbitrary numeric props on a target through the one tween engine. */
export function tween(
    target: Entity | Camera | object,
    props: Record<string, number>,
    seconds: number,
    easing?: Easing,
): Promise<void> {
    const rt = currentRuntime();
    const t = asTweenTarget(target);
    const scope =
        'entityId' in target
            ? entityScope(rt, target as Entity)
            : (currentInvocation()?.hostId ?? NO_SCOPE);
    return Promise.all(
        Object.entries(props).map(([prop, to]) =>
            rt.tweens.start(t, prop, to, seconds, scope, easing),
        ),
    ).then(() => undefined);
}

function asTweenTarget(target: object): TweenTarget {
    const obj = target as Record<string, number>;
    return {
        key: `object:${objectId(target)}`,
        get: (prop) => obj[prop] ?? 0,
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
