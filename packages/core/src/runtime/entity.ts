// The Entity facade (DESIGN §6, api_spec.ts:174). Holds an EntityId and delegates every
// accessor to the current runtime's stores. The transform is readonly and reads return
// COPIES, not aliases (§3.1) — a read stays valid after the body moves. Timed motion verbs
// are all one tween (§9.1). destroy() is logical-now, teardown-at-end-of-tick (§6).

import type { Vec3, Easing, Bounds } from '@platform/math';
import { atan2, vec3, vec3Dist, RAD2DEG } from '@platform/math';
import type { EntityId } from '../ids.js';
import type { BaseScript } from '../script/bases.js';
import type { Runtime } from './runtime.js';
import { entityKey } from './hosts.js';
import type { TweenTarget } from '../loop/tweens.js';
import type { AssetRef } from './assets.js';

export interface Collider {
    enabled: boolean;
    isTrigger: boolean;
    readonly bounds: Bounds;
}

export interface Animation {
    speed: number;
    readonly clip: string;
}

export class Entity {
    readonly #id: EntityId;
    readonly #rt: Runtime;

    constructor(id: EntityId, rt: Runtime) {
        this.#id = id;
        this.#rt = rt;
    }

    /** @internal */
    get entityId(): EntityId {
        return this.#id;
    }

    get id(): string {
        return String(this.#id as number);
    }

    get owner(): Player | null {
        const rec = this.#rt.entities.record(this.#id);
        if (!rec || rec.ownerId === '') return null;
        return this.#rt.playerManager?.byId(rec.ownerId) ?? null;
    }

    // ─── transform — readonly, reads return copies (§3.1) ───────────────────────

    get position(): Vec3 {
        return vec3(this.#rt.transforms.posX(this.#id), this.#rt.transforms.posY(this.#id), this.#rt.transforms.posZ(this.#id));
    }

    get rotation(): number {
        return this.#rt.transforms.rotation(this.#id);
    }

    get scale(): number {
        return this.#rt.transforms.scale(this.#id);
    }

    get opacity(): number {
        return this.#rt.transforms.opacity(this.#id);
    }

    set opacity(value: number) {
        this.#rt.transforms.setOpacity(this.#id, value);
    }

    get layer(): number {
        return this.#rt.transforms.layer(this.#id);
    }

    set layer(value: number) {
        this.#rt.transforms.setLayer(this.#id, value);
    }

    // ─── instant motion (chainable eager setters) ──────────────────────────────

    setPosition(x: number, y: number): this {
        this.#rt.transforms.setPosition(this.#id, x, y, this.#rt.transforms.posZ(this.#id));
        return this;
    }

    setRotation(degrees: number): this {
        this.#rt.transforms.setRotation(this.#id, degrees);
        return this;
    }

    rotateBy(degrees: number): this {
        this.#rt.transforms.setRotation(this.#id, this.#rt.transforms.rotation(this.#id) + degrees);
        return this;
    }

    setScale(scale: number): this {
        this.#rt.transforms.setScale(this.#id, scale);
        return this;
    }

    moveBy(dx: number, dy: number): this {
        this.#rt.transforms.setPosition(
            this.#id,
            this.#rt.transforms.posX(this.#id) + dx,
            this.#rt.transforms.posY(this.#id) + dy,
            this.#rt.transforms.posZ(this.#id),
        );
        return this;
    }

    moveToward(target: Entity | Vec3, speed: number): this {
        const to = resolvePoint(target);
        const x = this.#rt.transforms.posX(this.#id);
        const y = this.#rt.transforms.posY(this.#id);
        const dx = to.x - x;
        const dy = to.y - y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 0) {
            const step = Math.min(speed, dist);
            this.#rt.transforms.setPosition(this.#id, x + (dx / dist) * step, y + (dy / dist) * step, this.#rt.transforms.posZ(this.#id));
        }
        return this;
    }

    faceToward(target: Entity | Vec3): this {
        const to = resolvePoint(target);
        const dx = to.x - this.#rt.transforms.posX(this.#id);
        const dy = to.y - this.#rt.transforms.posY(this.#id);
        this.#rt.transforms.setRotation(this.#id, atan2(dy, dx) * RAD2DEG);
        return this;
    }

    distanceTo(target: Entity | Vec3): number {
        return vec3Dist(this.position, resolvePoint(target));
    }

    // ─── timed motion — all one tween (§9.1) ────────────────────────────────────

    glideTo(x: number, y: number, seconds: number, easing?: Easing): Promise<void> {
        const t = this.#tweenTarget();
        return Promise.all([
            this.#rt.tweens.start(t, 'x', x, seconds, this.#hostScope(), easing),
            this.#rt.tweens.start(t, 'y', y, seconds, this.#hostScope(), easing),
        ]).then(() => undefined);
    }

    glideBy(dx: number, dy: number, seconds: number, easing?: Easing): Promise<void> {
        return this.glideTo(this.#rt.transforms.posX(this.#id) + dx, this.#rt.transforms.posY(this.#id) + dy, seconds, easing);
    }

    fadeTo(opacity: number, seconds: number): Promise<void> {
        return this.#rt.tweens.start(this.#tweenTarget(), 'opacity', opacity, seconds, this.#hostScope());
    }

    fadeIn(seconds: number): Promise<void> {
        return this.fadeTo(1, seconds);
    }

    fadeOut(seconds: number): Promise<void> {
        return this.fadeTo(0, seconds);
    }

    growTo(scale: number, seconds: number): Promise<void> {
        return this.#rt.tweens.start(this.#tweenTarget(), 'scale', scale, seconds, this.#hostScope());
    }

    spin(degrees: number, seconds: number): Promise<void> {
        return this.#rt.tweens.start(this.#tweenTarget(), 'rotation', this.#rt.transforms.rotation(this.#id) + degrees, seconds, this.#hostScope());
    }

    spinTo(degrees: number, seconds: number): Promise<void> {
        return this.#rt.tweens.start(this.#tweenTarget(), 'rotation', degrees, seconds, this.#hostScope());
    }

    // ─── hierarchy — position only (§6) ─────────────────────────────────────────

    attachTo(parent: Entity): this {
        const rec = this.#rt.entities.record(this.#id);
        const prec = this.#rt.entities.record(parent.#id);
        if (!rec || !prec) return this;
        this.detach();
        rec.parent = parent.#id;
        prec.children.push(this.#id);
        this.#rt.channels.markStructural({ kind: 'reparent', id: this.#id, parent: parent.#id });
        return this;
    }

    detach(): this {
        const rec = this.#rt.entities.record(this.#id);
        if (!rec || rec.parent === (0 as EntityId)) return this;
        const prec = this.#rt.entities.record(rec.parent);
        if (prec) {
            const at = prec.children.indexOf(this.#id);
            if (at >= 0) prec.children.splice(at, 1);
        }
        rec.parent = 0 as EntityId;
        return this;
    }

    get parent(): Entity | null {
        const rec = this.#rt.entities.record(this.#id);
        if (!rec || rec.parent === (0 as EntityId)) return null;
        return this.#rt.entityManager.facade(rec.parent);
    }

    get children(): Entity[] {
        const rec = this.#rt.entities.record(this.#id);
        if (!rec) return [];
        return rec.children.map(c => this.#rt.entityManager.facade(c));
    }

    // ─── tags — an index (§6) ───────────────────────────────────────────────────

    tag(name: string): this {
        this.#rt.tags.add(this.#id, name);
        this.#rt.channels.markStructural({ kind: 'tag', id: this.#id, tag: name, added: true });
        return this;
    }

    untag(name: string): this {
        this.#rt.tags.remove(this.#id, name);
        this.#rt.channels.markStructural({ kind: 'tag', id: this.#id, tag: name, added: false });
        return this;
    }

    hasTag(name: string): boolean {
        return this.#rt.tags.has(this.#id, name);
    }

    get tags(): string[] {
        return [...this.#rt.tags.tagsOf(this.#id)];
    }

    collider?: Collider;
    animation?: Animation;

    getTouching(tag?: string, opts?: { asSeen?: boolean }): Entity[] {
        return this.#rt.contacts?.touching(this.#id, tag, opts?.asSeen ?? false) ?? [];
    }

    isTouching(tag?: string, opts?: { asSeen?: boolean }): boolean {
        return this.getTouching(tag, opts).length > 0;
    }

    // ─── visibility / effects (tier C — presentation) ──────────────────────────

    show(): this {
        this.#rt.transforms.setOpacity(this.#id, 1);
        return this;
    }

    hide(): this {
        this.#rt.transforms.setOpacity(this.#id, 0);
        return this;
    }

    play(clip: AssetRef, _opts?: { loop?: boolean }): Promise<void> {
        this.#rt.effects.play('animation', { id: this.#id, clip });
        return Promise.resolve();
    }

    stopAnimation(): this {
        return this;
    }

    playEffect(name: AssetRef, _opts?: { loop?: boolean }): this {
        this.#rt.effects.play('effect', { id: this.#id, name });
        return this;
    }

    // ─── speech bubbles — replicated entity state (§3.7) ────────────────────────

    say(text: string): this;
    say(text: string, seconds: number): Promise<void>;
    say(text: string, seconds?: number): this | Promise<void> {
        this.#rt.channels.markStructural({ kind: 'tag', id: this.#id, tag: `say:${text}`, added: true });
        if (seconds !== undefined) return this.#rt.timers.sleep(seconds, this.#hostScope());
        return this;
    }

    think(text: string): this;
    think(text: string, seconds: number): Promise<void>;
    think(text: string, seconds?: number): this | Promise<void> {
        if (seconds !== undefined) return this.#rt.timers.sleep(seconds, this.#hostScope());
        void text;
        return this;
    }

    clearSay(): this {
        return this;
    }

    // ─── lifecycle ──────────────────────────────────────────────────────────────

    destroy(): void {
        this.#rt.entityManager.destroy(this.#id);
    }

    get alive(): boolean {
        return this.#rt.entities.isAlive(this.#id);
    }

    addScript(script: new () => BaseScript<Entity>): this {
        this.#rt.wiring?.attachToEntity(this.#id, script as never);
        return this;
    }

    send(event: string, payload?: Record<string, unknown>): Promise<void> {
        return this.#rt.send?.(this.#id, event, payload) ?? Promise.resolve();
    }

    // ─── internals ──────────────────────────────────────────────────────────────

    #hostScope(): number {
        return this.#rt.hosts.ensure(entityKey(this.#id as number)).scopeId;
    }

    #tweenTarget(): TweenTarget {
        const id = this.#id;
        const store = this.#rt.transforms;
        return {
            key: `entity:${id as number}`,
            get(prop: string): number {
                switch (prop) {
                    case 'x': return store.posX(id);
                    case 'y': return store.posY(id);
                    case 'rotation': return store.rotation(id);
                    case 'scale': return store.scale(id);
                    case 'opacity': return store.opacity(id);
                    default: return 0;
                }
            },
            set(prop: string, value: number): void {
                switch (prop) {
                    case 'x': store.setPosition(id, value, store.posY(id), store.posZ(id)); break;
                    case 'y': store.setPosition(id, store.posX(id), value, store.posZ(id)); break;
                    case 'rotation': store.setRotation(id, value); break;
                    case 'scale': store.setScale(id, value); break;
                    case 'opacity': store.setOpacity(id, value); break;
                }
            },
        };
    }
}

function resolvePoint(target: Entity | Vec3): Vec3 {
    return target instanceof Entity ? target.position : target;
}

import type { Player } from './player.js';
