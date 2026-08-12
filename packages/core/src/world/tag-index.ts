// Iteration is insertion order — the stable order determinism needs.

import type { EntityId } from '../ids.js';
import { entityIndex } from '../ids.js';
import type { Scope, ScopeMode, SnapshotStore } from '../loop/store-registry.js';

export interface TagBuffer {
    byTag: Map<string, Set<EntityId>>;
    byEntity: Map<number, Set<string>>;
    /** Entities this buffer covers, or null for the whole index; a scoped `apply` restores only these. */
    slots: number[] | null;
}

export class TagIndex implements SnapshotStore<TagBuffer> {
    readonly storeName = 'tags';
    readonly scopeMode: ScopeMode = 'filtered';

    readonly #byTag = new Map<string, Set<EntityId>>();
    readonly #byEntity = new Map<number, Set<string>>();

    add(id: EntityId, tag: string): void {
        let tagSet = this.#byTag.get(tag);
        if (!tagSet) {
            tagSet = new Set();
            this.#byTag.set(tag, tagSet);
        }
        tagSet.add(id);

        const index = entityIndex(id);
        let entityTags = this.#byEntity.get(index);
        if (!entityTags) {
            entityTags = new Set();
            this.#byEntity.set(index, entityTags);
        }
        entityTags.add(tag);
    }

    remove(id: EntityId, tag: string): void {
        const tagSet = this.#byTag.get(tag);
        if (tagSet) {
            tagSet.delete(id);
            if (tagSet.size === 0) this.#byTag.delete(tag);
        }

        const index = entityIndex(id);
        const entityTags = this.#byEntity.get(index);
        if (entityTags) {
            entityTags.delete(tag);
            if (entityTags.size === 0) this.#byEntity.delete(index);
        }
    }

    has(id: EntityId, tag: string): boolean {
        return this.#byTag.get(tag)?.has(id) ?? false;
    }

    tagsOf(id: EntityId): readonly string[] {
        const index = entityIndex(id);
        const entityTags = this.#byEntity.get(index);
        return entityTags ? [...entityTags] : [];
    }

    entitiesWithTag(tag: string): ReadonlySet<EntityId> {
        return this.#byTag.get(tag) ?? EMPTY_SET;
    }

    removeAll(id: EntityId): void {
        const index = entityIndex(id);
        const entityTags = this.#byEntity.get(index);
        if (!entityTags) return;
        for (const tag of entityTags) {
            const tagSet = this.#byTag.get(tag);
            if (tagSet) {
                tagSet.delete(id);
                if (tagSet.size === 0) this.#byTag.delete(tag);
            }
        }
        this.#byEntity.delete(index);
    }

    clear(): void {
        this.#byTag.clear();
        this.#byEntity.clear();
    }

    createBuffer(): TagBuffer {
        return { byTag: new Map(), byEntity: new Map(), slots: null };
    }

    capture(into: TagBuffer, scope: Scope): void {
        into.byTag.clear();
        into.byEntity.clear();

        if (scope === null) {
            into.slots = null;
            for (const [tag, ids] of this.#byTag) {
                into.byTag.set(tag, new Set(ids));
            }
            for (const [index, tags] of this.#byEntity) {
                into.byEntity.set(index, new Set(tags));
            }
            return;
        }

        // Every id in scope, tagged or not: an entity that lost its last tag after the capture
        // must end up untagged on restore, which an absent entry cannot express.
        const slots = into.slots ?? [];
        slots.length = 0;
        for (const id of scope) {
            const index = entityIndex(id);
            slots.push(index);
            const entityTags = this.#byEntity.get(index);
            if (!entityTags) continue;
            into.byEntity.set(index, new Set(entityTags));
            for (const tag of entityTags) {
                let tagSet = into.byTag.get(tag);
                if (!tagSet) {
                    tagSet = new Set();
                    into.byTag.set(tag, tagSet);
                }
                tagSet.add(id);
            }
        }
        into.slots = slots;
    }

    apply(from: TagBuffer): void {
        if (from.slots === null) {
            this.#byTag.clear();
            this.#byEntity.clear();
        } else {
            // Clearing the whole index would drop every out-of-scope entity's tags.
            for (const index of from.slots) this.#clearSlot(index);
        }

        for (const [index, tags] of from.byEntity) {
            this.#byEntity.set(index, new Set(tags));
        }
        for (const [tag, ids] of from.byTag) {
            const existing = this.#byTag.get(tag);
            if (existing) for (const id of ids) existing.add(id);
            else this.#byTag.set(tag, new Set(ids));
        }
    }

    /** Drops one entity from both directions of the index, leaving every other entity alone. */
    #clearSlot(index: number): void {
        const entityTags = this.#byEntity.get(index);
        if (!entityTags) return;
        for (const tag of entityTags) {
            const tagSet = this.#byTag.get(tag);
            if (!tagSet) continue;
            for (const id of tagSet) {
                if (entityIndex(id) === index) tagSet.delete(id);
            }
            if (tagSet.size === 0) this.#byTag.delete(tag);
        }
        this.#byEntity.delete(index);
    }
}

const EMPTY_SET: ReadonlySet<EntityId> = new Set();
