// Tags are an index: name → entity set. `find({ tag })` is a lookup rather than a
// scan (DESIGN §6). Iteration order is insertion order — the engine-stable order
// determinism requires (§1.2).

import type { EntityId } from '../ids.js';
import { entityIndex } from '../ids.js';
import type { Scope, ScopeMode, SnapshotStore } from '../loop/store-registry.js';

export interface TagBuffer {
    byTag: Map<string, Set<EntityId>>;
    byEntity: Map<number, Set<string>>;
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

    // ─── snapshot/restore ────────────────────────────────────────────────────────

    createBuffer(): TagBuffer {
        return { byTag: new Map(), byEntity: new Map() };
    }

    capture(into: TagBuffer, scope: Scope): void {
        into.byTag.clear();
        into.byEntity.clear();

        if (scope === null) {
            for (const [tag, ids] of this.#byTag) {
                into.byTag.set(tag, new Set(ids));
            }
            for (const [index, tags] of this.#byEntity) {
                into.byEntity.set(index, new Set(tags));
            }
        } else {
            for (const id of scope) {
                const index = entityIndex(id);
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
        }
    }

    apply(from: TagBuffer): void {
        this.#byTag.clear();
        this.#byEntity.clear();
        for (const [tag, ids] of from.byTag) {
            this.#byTag.set(tag, new Set(ids));
        }
        for (const [index, tags] of from.byEntity) {
            this.#byEntity.set(index, new Set(tags));
        }
    }
}

const EMPTY_SET: ReadonlySet<EntityId> = new Set();
