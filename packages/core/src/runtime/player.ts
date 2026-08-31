// @serverState on a Player-hosted script hoists onto the player's host record, so `player.credits`
// reads through the same record `this.credits` writes.

import type { Vec3 } from '@platform/math';
import { vec3 } from '@platform/math';
import type { ScriptProps } from '@platform/project';
import type { BaseScript } from '../script/bases.js';
import type { Runtime } from './runtime.js';
import type { Entity } from './entity.js';
import type { Camera } from './camera.js';
import type { Storage } from './wrappers.js';
import type { BaseMovement } from './movement.js';
import type { ScriptQuery } from './get-script.js';
import { scriptOnHost } from './get-script.js';
import { cameraKey, playerKey } from './hosts.js';

export interface Cursor {
    readonly position: Vec3;
    readonly screenPosition: Vec3;
    readonly over: Entity | null;
    readonly isDown: boolean;
    visible: boolean;
    setIcon(icon: 'crosshair' | 'hand' | 'default' | string): void;
    lock(): void;
    unlock(): void;
}

export interface InputBindings {
    rebind(action: string, bindings: string[]): void;
    addBinding(action: string, binding: string): void;
    getBindings(action: string): string[];
    resetBindings(action?: string): void;
    setContext(context: string): void;
}

export interface ActionState {
    held(action: string): boolean;
    pressed(action: string): boolean;
    released(action: string): boolean;
    axis(action: string): number;
}

class NullCursor implements Cursor {
    get position(): Vec3 {
        return vec3();
    }
    get screenPosition(): Vec3 {
        return vec3();
    }
    get over(): Entity | null {
        return null;
    }
    get isDown(): boolean {
        return false;
    }
    visible = true;
    setIcon(): void {}
    lock(): void {}
    unlock(): void {}
}

class MemoryBindings implements InputBindings {
    readonly #b = new Map<string, string[]>();
    rebind(action: string, bindings: string[]): void {
        this.#b.set(action, [...bindings]);
    }
    addBinding(action: string, binding: string): void {
        this.#b.set(action, [...(this.#b.get(action) ?? []), binding]);
    }
    getBindings(action: string): string[] {
        return [...(this.#b.get(action) ?? [])];
    }
    resetBindings(action?: string): void {
        if (action === undefined) this.#b.clear();
        else this.#b.delete(action);
    }
    setContext(): void {}
}

export class Player {
    readonly #rt: Runtime;
    readonly id: string;
    readonly index: number;
    name: string;

    readonly cursor: Cursor = new NullCursor();
    readonly input: InputBindings = new MemoryBindings();

    #avatar: Entity | null = null;
    #camera: Camera | null = null;
    #storage: Storage | null = null;
    movement?: BaseMovement;

    /** @internal — set by the roster. */
    setMovementInstance(movement: BaseMovement | undefined): void {
        if (movement === undefined) delete this.movement;
        else this.movement = movement;
    }

    /** @internal — a spectating or bodiless player has no movement. */
    clearMovement(): void {
        delete this.movement;
    }

    constructor(rt: Runtime, id: string, index: number, name: string) {
        this.#rt = rt;
        this.id = id;
        this.index = index;
        this.name = name;
    }

    /** @internal — the non-throwing test, for engine code that must branch rather than catch. */
    get hasAvatar(): boolean {
        return this.#avatar !== null;
    }

    get avatar(): Entity {
        if (!this.#avatar)
            throw new Error(`player ${this.id} has no avatar (spectating or bodiless)`);
        return this.#avatar;
    }

    /** @internal — set by spawn/roster wiring. */
    setAvatar(entity: Entity | null): void {
        this.#avatar = entity;
    }

    get camera(): Camera {
        if (!this.#camera) this.#camera = this.#rt.wired.makeCamera(this);
        return this.#camera;
    }

    get storage(): Storage {
        if (!this.#storage) this.#storage = this.#rt.wired.makeStorage(this);
        return this.#storage;
    }

    spawn(): void {
        this.#rt.wired.roster.spawnAvatar(this);
    }

    spectate(): void {
        this.#rt.wired.roster.spectate(this);
    }

    respawn(): void {
        this.#rt.wired.roster.respawn(this);
    }

    teleportTo(x: number, y: number): void {
        if (this.#avatar) this.#avatar.setPosition(x, y);
    }

    setMovement(movement: new () => BaseMovement): this {
        this.#rt.wired.roster.setMovement(this, movement);
        return this;
    }

    addScript(script: new (props?: ScriptProps) => BaseScript<Player>, props?: ScriptProps): this {
        this.#rt.wired.wiring.attachToPlayer(this, script, props);
        return this;
    }

    /**
     * This player's instance of `script`, or `null` when it carries none.
     *
     * The typed way to reach another host's `@serverState` — `player.getScript(Profile)?.credits`
     * rather than a cast against a field the `Player` type cannot declare — and the way one script
     * calls another's method without a module-level slot to publish it through.
     */
    getScript<T extends BaseScript<Player>>(script: ScriptQuery<T>): T | null {
        return scriptOnHost(this.#rt, playerKey(this.id), script);
    }
}

/** Owns the roster and the player host records. */
export class PlayerManager {
    readonly #rt: Runtime;
    readonly #byId = new Map<string, Player>();
    readonly #order: Player[] = [];
    #nextIndex = 0;

    constructor(rt: Runtime) {
        this.#rt = rt;
    }

    create(id: string, name: string): Player {
        const player = new Player(this.#rt, id, this.#nextIndex++, name);
        this.#byId.set(id, player);
        this.#order.push(player);
        this.#rt.hosts.ensure(playerKey(id));
        return player;
    }

    /**
     * Registers a Player built elsewhere, keeping the index it already carries.
     *
     * `create` would renumber from arrival order, and a client mirror's numbering then drifts from
     * the server's the first time a player leaves — but `index` is stable for the session and
     * observable, so it has to come from whoever is authoritative about it.
     */
    adopt(player: Player): void {
        if (this.#byId.has(player.id)) return;
        this.#byId.set(player.id, player);
        this.#order.push(player);
        this.#nextIndex = Math.max(this.#nextIndex, player.index + 1);
        this.#rt.hosts.ensure(playerKey(player.id));
    }

    byId(id: string): Player | null {
        return this.#byId.get(id) ?? null;
    }

    remove(id: string): void {
        const player = this.#byId.get(id);
        if (!player) return;
        this.#byId.delete(id);
        const at = this.#order.indexOf(player);
        if (at >= 0) this.#order.splice(at, 1);
        // Instances before the host: the update pass walks every instance, so a departed player's
        // scripts would keep taking @onUpdate against a scope that no longer exists.
        this.#rt.instances.removeHost(playerKey(id));
        this.#rt.hosts.remove(playerKey(id));
        // The camera goes with them: it is one player's view, so a surviving camera host would keep
        // its scripts dispatching against a player the roster no longer holds.
        this.#rt.instances.removeHost(cameraKey(id));
        this.#rt.hosts.remove(cameraKey(id));
    }

    get players(): Player[] {
        return [...this.#order];
    }
}
