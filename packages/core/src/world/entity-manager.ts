// One facade per live id, so `===` identity holds across reads of the same entity.
// Teardown is deferred to the tick's destroy drain so a mid-dispatch destroy cannot mutate
// the live list underneath the pass that is walking it.

import type { EntityId } from '../ids.js';
import type { Runtime } from '../runtime/runtime.js';
import type { Entity } from '../runtime/entity.js';
import { entityKey } from '../runtime/hosts.js';
import { NO_SCOPE } from '../dispatch/scope-tree.js';

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

    /** Spawns an entity from a template, at (x, y). */
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
        const cached = this.#facades.get(key);
        if (cached) return cached;

        const made = this.makeFacade(id);
        // Only a live id earns a cache entry, which the destroy drain later removes. Caching every
        // id asked for let a stale or historical handle add an entry nothing would ever evict.
        if (this.#rt.entities.exists(id)) this.#facades.set(key, made);
        return made;
    }

    /** Flips `alive` false now, for this entity and its subtree; queues teardown for the drain. */
    destroy(id: EntityId): void {
        const record = this.#rt.entities.record(id);
        if (!record || !record.alive) return;
        record.alive = false;
        record.destroyPending = true;
        this.#pendingDestroy.push(id);
        for (const child of record.children) {
            this.destroy(child);
        }
    }

    /** Removes queued entities from every index; runs once per tick. */
    drainDestroyed(): void {
        if (this.#pendingDestroy.length === 0) return;
        const doomed = this.#pendingDestroy.splice(0);
        for (const id of doomed) {
            const record = this.#rt.entities.record(id);
            if (record) {
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
            const scope = this.#rt.hosts.scopeForEntity(id as number);
            // An entity with no host record owns nothing; cancelling NO_SCOPE would reach every
            // timer that never got a host instead.
            if (scope !== NO_SCOPE) {
                this.#rt.tweens.cancelScope(scope);
                this.#rt.timers.cancelScope(scope);
            }
            this.#rt.instances.removeHost(entityKey(id as number));
            this.#rt.hosts.remove(entityKey(id as number));
            this.#rt.channels.markStructural({ kind: 'destroy', id });
            this.#rt.entities.release(id);
            this.#facades.delete(id as number);
        }
    }

    clear(): void {
        this.#facades.clear();
        this.#pendingDestroy.length = 0;
    }
}
