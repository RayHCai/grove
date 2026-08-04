import type { Vec3, Easing } from '@platform/math';
import type { Entity } from './entity.js';
import type { Camera } from './camera.js';

export function oscillate(_entity: Entity, _axis: 'x' | 'y', _amount: number, _seconds: number): void {}

export function orbit(_entity: Entity, _center: Entity | Vec3, _radius: number, _speed: number): void {}

export function tween(
    _target: Entity | Camera | object,
    _props: Record<string, number>,
    _seconds: number,
    _easing?: Easing,
): Promise<void> {
    return Promise.resolve();
}
