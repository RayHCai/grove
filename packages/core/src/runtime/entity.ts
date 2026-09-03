// Transform reads return copies, not aliases, so a read stays valid after the body moves.
// destroy() is logical-now, teardown-at-end-of-tick.

import type { Vec3, Easing, Bounds } from '@platform/math';
import { atan2, vec3, vec3Dist2D, RAD2DEG } from '@platform/math';
import type { EntityId } from '../ids.js';
import { NO_ENTITY } from '../ids.js';
import type { ScriptProps } from '@platform/project';
import type { BaseScript } from '../script/bases.js';
import type { Runtime } from './runtime.js';
import type { ScriptQuery } from './get-script.js';
import { scriptOnHost } from './get-script.js';
import { entityKey } from './hosts.js';
import type { TweenTarget } from '../loop/tweens.js';
import { resumeWith } from '../dispatch/ambient.js';
import { LoadError } from '../errors.js';
import type { AssetRef } from './assets.js';
import type { Player } from './player.js';
import { MAX_BUBBLE_LENGTH } from '../config.js';

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
    /** The tag `say` marked, since clearing one is marking the removal of the exact string sent. */
    #bubble: string | null = null;

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
        return this.#rt.wired.playerManager.byId(rec.ownerId);
    }

    get position(): Vec3 {
        return vec3(
            this.#rt.transforms.posX(this.#id),
            this.#rt.transforms.posY(this.#id),
            this.#rt.transforms.posZ(this.#id),
        );
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
            this.#rt.transforms.setPosition(
                this.#id,
                x + (dx / dist) * step,
                y + (dy / dist) * step,
                this.#rt.transforms.posZ(this.#id),
            );
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
        return vec3Dist2D(this.position, resolvePoint(target));
    }

    glideTo(x: number, y: number, seconds: number, easing?: Easing): Promise<void> {
        const t = this.#tweenTarget();
        return resumeWith(
            Promise.all([
                this.#rt.tweens.start(t, 'x', x, seconds, this.#hostScope(), easing),
                this.#rt.tweens.start(t, 'y', y, seconds, this.#hostScope(), easing),
            ]).then(() => undefined),
        );
    }

    glideBy(dx: number, dy: number, seconds: number, easing?: Easing): Promise<void> {
        return this.glideTo(
            this.#rt.transforms.posX(this.#id) + dx,
            this.#rt.transforms.posY(this.#id) + dy,
            seconds,
            easing,
        );
    }

    fadeTo(opacity: number, seconds: number): Promise<void> {
        return this.#rt.tweens.start(
            this.#tweenTarget(),
            'opacity',
            opacity,
            seconds,
            this.#hostScope(),
        );
    }

    fadeIn(seconds: number): Promise<void> {
        return this.fadeTo(1, seconds);
    }

    fadeOut(seconds: number): Promise<void> {
        return this.fadeTo(0, seconds);
    }

    growTo(scale: number, seconds: number): Promise<void> {
        return this.#rt.tweens.start(
            this.#tweenTarget(),
            'scale',
            scale,
            seconds,
            this.#hostScope(),
        );
    }

    spin(degrees: number, seconds: number): Promise<void> {
        return this.#rt.tweens.start(
            this.#tweenTarget(),
            'rotation',
            this.#rt.transforms.rotation(this.#id) + degrees,
            seconds,
            this.#hostScope(),
        );
    }

    spinTo(degrees: number, seconds: number): Promise<void> {
        return this.#rt.tweens.start(
            this.#tweenTarget(),
            'rotation',
            degrees,
            seconds,
            this.#hostScope(),
        );
    }

    attachTo(parent: Entity): this {
        const rec = this.#rt.entities.record(this.#id);
        const prec = this.#rt.entities.record(parent.#id);
        // A destroy-pending parent already cascaded; a child linked under it dies with it.
        if (!rec || !prec || !prec.alive) return this;
        // Refused where the authored path refuses a template that contains itself: a chain with no
        // root is a walk that never ends, for the destroy cascade and for anything that follows it.
        let at: EntityId = parent.#id;
        while (at !== NO_ENTITY) {
            if (at === this.#id) {
                throw new LoadError(`entity ${this.id} cannot be attached beneath its own subtree`);
            }
            at = this.#rt.entities.record(at)?.parent ?? NO_ENTITY;
        }
        // #unlink rather than detach(), whose mark would put two ops on the wire for one move.
        this.#unlink();
        rec.parent = parent.#id;
        prec.children.push(this.#id);
        this.#rt.channels.markStructural({ kind: 'reparent', id: this.#id, parent: parent.#id });
        return this;
    }

    detach(): this {
        // The transform channel carries no hierarchy, so an unmarked detach never reaches clients.
        if (this.#unlink()) {
            this.#rt.channels.markStructural({
                kind: 'reparent',
                id: this.#id,
                parent: NO_ENTITY,
            });
        }
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
        return rec.children.map((c) => this.#rt.entityManager.facade(c));
    }

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

    // Specified as template-configured; nothing in the template pipeline writes either, so a
    // collider exists only where a script assigned one and `getTouching` answers nothing until
    // it does.
    collider?: Collider;
    animation?: Animation;

    getTouching(tag?: string, opts?: { asSeen?: boolean }): Entity[] {
        return this.#rt.wired.contacts.touching(this.#id, tag, opts?.asSeen ?? false);
    }

    isTouching(tag?: string, opts?: { asSeen?: boolean }): boolean {
        return this.getTouching(tag, opts).length > 0;
    }

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

    say(text: string): this;
    say(text: string, seconds: number): Promise<void>;
    say(text: string, seconds?: number): this | Promise<void> {
        // Capped here rather than at the renderer: this string goes on the wire, so an unbounded
        // one is a per-tick broadcast of whatever a client can talk the game into.
        const tag = `say:${text.slice(0, MAX_BUBBLE_LENGTH)}`;
        this.clearSay();
        this.#bubble = tag;
        this.#rt.channels.markStructural({ kind: 'tag', id: this.#id, tag, added: true });
        if (seconds === undefined) return this;
        return this.#rt.timers.sleep(seconds, this.#hostScope()).then(() => {
            // Its own bubble only: a say() during the sleep already replaced this one.
            if (this.#bubble === tag) this.clearSay();
        });
    }

    think(text: string): this;
    think(text: string, seconds: number): Promise<void>;
    think(text: string, seconds?: number): this | Promise<void> {
        if (seconds !== undefined) return this.#rt.timers.sleep(seconds, this.#hostScope());
        void text;
        return this;
    }

    clearSay(): this {
        const tag = this.#bubble;
        if (tag === null) return this;
        this.#bubble = null;
        this.#rt.channels.markStructural({ kind: 'tag', id: this.#id, tag, added: false });
        return this;
    }

    destroy(): void {
        this.#rt.entityManager.destroy(this.#id);
    }

    get alive(): boolean {
        return this.#rt.entities.isAlive(this.#id);
    }

    addScript(script: new (props?: ScriptProps) => BaseScript<Entity>, props?: ScriptProps): this {
        this.#rt.wired.wiring.attachToEntity(this.#id, script as never, props);
        return this;
    }

    /**
     * This entity's instance of `script`, or `null` when it carries none.
     *
     * The typed way to reach another host's `@serverState` — `leaf.getScript(Leaf)?.ripe` rather
     * than a cast against a field the `Entity` type cannot declare.
     */
    getScript<T extends BaseScript<Entity>>(script: ScriptQuery<T>): T | null {
        return scriptOnHost(this.#rt, entityKey(this.#id as number), script);
    }

    send(event: string, payload?: Record<string, unknown>): Promise<void> {
        return this.#rt.wired.send(this.#id, event, payload);
    }

    /** Unparents without marking; returns false if it had no parent. */
    #unlink(): boolean {
        const rec = this.#rt.entities.record(this.#id);
        if (!rec || rec.parent === NO_ENTITY) return false;
        const prec = this.#rt.entities.record(rec.parent);
        if (prec) {
            const at = prec.children.indexOf(this.#id);
            if (at >= 0) prec.children.splice(at, 1);
        }
        rec.parent = NO_ENTITY;
        return true;
    }

    #hostScope(): number {
        return this.#rt.hosts.ensure(entityKey(this.#id as number)).scopeId;
    }

    #tweenTarget(): TweenTarget {
        const id = this.#id;
        const store = this.#rt.transforms;
        return {
            key: entityKey(id as number),
            get(prop: string): number {
                switch (prop) {
                    case 'x':
                        return store.posX(id);
                    case 'y':
                        return store.posY(id);
                    case 'rotation':
                        return store.rotation(id);
                    case 'scale':
                        return store.scale(id);
                    case 'opacity':
                        return store.opacity(id);
                    default:
                        return 0;
                }
            },
            set(prop: string, value: number): void {
                switch (prop) {
                    case 'x':
                        store.setPosition(id, value, store.posY(id), store.posZ(id));
                        break;
                    case 'y':
                        store.setPosition(id, store.posX(id), value, store.posZ(id));
                        break;
                    case 'rotation':
                        store.setRotation(id, value);
                        break;
                    case 'scale':
                        store.setScale(id, value);
                        break;
                    case 'opacity':
                        store.setOpacity(id, value);
                        break;
                }
            },
        };
    }
}

function resolvePoint(target: Entity | Vec3): Vec3 {
    return target instanceof Entity ? target.position : target;
}
