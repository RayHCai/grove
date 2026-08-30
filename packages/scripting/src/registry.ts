// An id is read off the chunk and never off `klass.name`, which a minifier renames.

import type { BaseScript, ScriptLocation, ScriptMetadata } from '@platform/core';
import { LoadError, getMetadata } from '@platform/core';

/** A script class, as an attach site takes it. */
export type ScriptClass = new () => BaseScript;

/** One class as a chunk carries it. */
export interface ScriptEntry<Id extends string = string> {
    readonly id: Id;
    readonly location: ScriptLocation;
    readonly ctor: ScriptClass;
}

/** What a side chunk's module exports: which side it was linked for, and its classes by id. */
export interface ScriptChunkModule<Id extends string = string> {
    readonly side: ScriptSide;
    readonly scripts: readonly ScriptEntry<Id>[];
}

/** The two link targets. A `SyncedScript` reaches both; the other two locations reach one. */
export type ScriptSide = 'client' | 'server';

/** Which locations link into a side's chunk — server+synced there, client+synced here. */
export function locationsFor(side: ScriptSide): ReadonlySet<ScriptLocation> {
    return side === 'server' ? SERVER_LOCATIONS : CLIENT_LOCATIONS;
}

const SERVER_LOCATIONS: ReadonlySet<ScriptLocation> = new Set(['server', 'synced']);
const CLIENT_LOCATIONS: ReadonlySet<ScriptLocation> = new Set(['client', 'synced']);

/**
 * A chunk's classes, by the id the bundle stamped on them.
 *
 * The id parameter is left open so a consumer holding an authoring `ScriptId` brand narrows to it
 * without this package taking a dependency on the package that mints one.
 */
export class ScriptRegistry<Id extends string = string> {
    readonly #byId: ReadonlyMap<Id, ScriptEntry<Id>>;
    readonly #byClass: ReadonlyMap<ScriptClass, Id>;

    private constructor(byId: ReadonlyMap<Id, ScriptEntry<Id>>) {
        this.#byId = byId;
        this.#byClass = new Map([...byId.values()].map((e) => [e.ctor, e.id]));
    }

    /** Builds a registry over a chunk's `scripts` export. A repeated id or class is fatal. */
    static from<Id extends string = string>(
        entries: Iterable<ScriptEntry<Id>>,
    ): ScriptRegistry<Id> {
        const byId = new Map<Id, ScriptEntry<Id>>();
        const seen = new Map<ScriptClass, Id>();
        for (const entry of entries) {
            if (byId.has(entry.id)) {
                throw new LoadError(`two script classes claim the id "${entry.id}"`);
            }
            const first = seen.get(entry.ctor);
            if (first !== undefined) {
                throw new LoadError(
                    `one script class is registered twice, as "${first}" and "${entry.id}"`,
                );
            }
            seen.set(entry.ctor, entry.id);
            byId.set(entry.id, entry);
        }
        return new ScriptRegistry(byId);
    }

    get size(): number {
        return this.#byId.size;
    }

    has(id: Id): boolean {
        return this.#byId.has(id);
    }

    resolve(id: Id): ScriptClass | undefined {
        return this.#byId.get(id)?.ctor;
    }

    locationOf(id: Id): ScriptLocation | undefined {
        return this.#byId.get(id)?.location;
    }

    /** The id a class was stamped with — the reverse edge an attach site needs to name it on the wire. */
    idOf(ctor: ScriptClass): Id | undefined {
        return this.#byClass.get(ctor);
    }

    /**
     * The class's handler and `@serverState` tables, read back through core's decorator metadata.
     *
     * Empty tables on a decorated class mean the decorators reached the chunk unlowered.
     */
    metadataOf(id: Id): ScriptMetadata | undefined {
        const ctor = this.#byId.get(id)?.ctor;
        return ctor ? getMetadata(ctor) : undefined;
    }

    /** Ids in the order the chunk carries them, which is sorted. */
    ids(): Id[] {
        return [...this.#byId.keys()];
    }

    entries(): ScriptEntry<Id>[] {
        return [...this.#byId.values()];
    }
}
