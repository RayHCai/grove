// Mints and tears down entities, and caches one Entity facade per live id so `===`
// identity holds across reads (a stale reference is a no-op, DESIGN §6). The facade
// delegates every accessor to the runtime's stores addressed by its EntityId.
//
// destroy() is logical-now, teardown-at-end-of-tick (§6): `alive` flips false immediately
// so `crate.send('break'); crate.alive === false` holds, while removal drains in the
// tick's destroy phase, which stops a mid-dispatch destroy from mutating the live list.

import type { EntityId } from '../ids.js';
import type { Runtime } from '../runtime/runtime.js';
import type { Entity } from '../runtime/entity.js';

export class EntityManager {
    readonly #rt: Runtime;
    readonly #facades = new Map<number, Entity>();
    readonly #pendingDestroy: EntityId[] = [];

    /** Builds a facade for an id; set by the runtime wiring to avoid an import cycle. */
    makeFacade: (id: EntityId) => Entity = () => {
        throw new Error('EntityManager.makeFacade not wired');
    };

    constructor(rt: Runtime) {
        this.#rt = rt;
    }

    /** Spawns an entity from a template, at (x, y). Structural mark + transform init. */
    spawn(template: string, x = 0, y = 0, ownerId = ''): Entity {
        const id = this.#rt.entities.create(template, ownerId);
        this.#rt.transforms.initSlot(id);
        this.#rt.transforms.setPosition(id, x, y, 0);
        this.#rt.channels.markStructural({ kind: 'spawn', id, template });
        return this.facade(id);
    }

    /** The cached facade for a live id, minting one on first access. */
    facade(id: EntityId): Entity {
        const key = id as number;
        let f = this.#facades.get(key);
        if (!f) {
            f = this.makeFacade(id);
            this.#facades.set(key, f);
        }
        return f;
    }

    /** Flips `alive` false now; queues teardown for the destroy drain (§6). */
    destroy(id: EntityId): void {
        const record = this.#rt.entities.record(id);
        if (!record || !record.alive) return;
        record.alive = false;
        record.destroyPending = true;
        this.#pendingDestroy.push(id);
        // Cascade to children logically-now, so `alive` is false for the whole subtree.
        for (const child of record.children) {
            this.destroy(child);
        }
    }

    /** The tick's destroy phase (§8.2 step 9): removes queued entities from every index. */
    drainDestroyed(): void {
        if (this.#pendingDestroy.length === 0) return;
        const doomed = this.#pendingDestroy.splice(0);
        for (const id of doomed) {
            const record = this.#rt.entities.record(id);
            if (record) {
                // Detach from parent's child list.
                if (record.parent) {
                    const parent = this.#rt.entities.record(record.parent);
                    if (parent) {
                        const at = parent.children.indexOf(id);
                        if (at >= 0) parent.children.splice(at, 1);
                    }
                }
            }
            this.#rt.tags.removeAll(id);
            this.#rt.transforms.releaseSlot(id);
            this.#rt.tweens.cancelScope(this.#rt.hosts.scopeForEntity(id as number));
            this.#rt.timers.cancelScope(this.#rt.hosts.scopeForEntity(id as number));
            this.#rt.instances.removeHost(`entity:${id as number}`);
            this.#rt.hosts.remove(`entity:${id as number}`);
            this.#rt.channels.markStructural({ kind: 'destroy', id });
            this.#rt.entities.release(id);
            this.#facades.delete(id as number);
        }
    }

    get pendingDestroyCount(): number {
        return this.#pendingDestroy.length;
    }

    clear(): void {
        this.#facades.clear();
        this.#pendingDestroy.length = 0;
    }
}
