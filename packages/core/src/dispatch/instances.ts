// Each instance carries a stable id because concurrency locks are keyed per instance —
// keyed by method alone, one player's cooldown would gate every other player's.

import type { HandlerDecl, ScriptLocation } from '../script/index.js';
import { getMetadata } from '../script/index.js';
import type { GuardOwner, ScopeId } from './scope-tree.js';

let nextInstanceId = 1;

export interface ScriptInstance extends GuardOwner {
    readonly instance: object;
    readonly klass: abstract new (...args: never[]) => object;
    readonly location: ScriptLocation;
    /** Handlers this class declares, resolved from prototype-chain metadata. */
    readonly handlers: readonly HandlerDecl[];
}

/** Reads the location a script class declares via its base (`__location`). */
export function locationOf(klass: abstract new (...args: never[]) => object): ScriptLocation {
    return (klass as unknown as { __location: ScriptLocation }).__location;
}

export function makeInstance(
    instance: object,
    klass: abstract new (...args: never[]) => object,
    hostScopeId: ScopeId,
): ScriptInstance {
    const meta = getMetadata(klass);
    return {
        id: nextInstanceId++,
        instance,
        klass,
        className: klass.name,
        location: locationOf(klass),
        handlers: meta?.handlers ?? [],
        hostScopeId,
    };
}

/** The script instances attached to each host. */
export class InstanceRegistry {
    /** hostKey → its instances in attachment order, which is dispatch order. */
    readonly #byHost = new Map<string, ScriptInstance[]>();
    /** The reverse edge, for engine code holding a script object and needing its identity. */
    readonly #byInstance = new WeakMap<object, ScriptInstance>();

    attach(hostKey: string, inst: ScriptInstance): void {
        let list = this.#byHost.get(hostKey);
        if (!list) {
            list = [];
            this.#byHost.set(hostKey, list);
        }
        list.push(inst);
        this.#byInstance.set(inst.instance, inst);
    }

    forHost(hostKey: string): readonly ScriptInstance[] {
        return this.#byHost.get(hostKey) ?? EMPTY;
    }

    /**
     * The registration for a script object, or undefined for one never attached.
     *
     * A pass that holds the instance — movement is the one — otherwise has no way back to the id a
     * breaker entry is keyed by, short of scanning its host's list for object identity.
     */
    forInstance(instance: object): ScriptInstance | undefined {
        return this.#byInstance.get(instance);
    }

    removeHost(hostKey: string): void {
        this.#byHost.delete(hostKey);
    }

    *all(): IterableIterator<ScriptInstance> {
        for (const list of this.#byHost.values()) {
            yield* list;
        }
    }

    /**
     * Every instance paired with the host key it hangs off.
     *
     * A whole-world dispatch that has to branch on WHICH host — a widget press, which a screen-hosted
     * handler answers only for its own screen — cannot get that from `all()`, and re-deriving it by
     * scanning `forHost` per candidate key is quadratic in the registry.
     */
    *entries(): IterableIterator<readonly [string, ScriptInstance]> {
        for (const [hostKey, list] of this.#byHost) {
            for (const inst of list) yield [hostKey, inst];
        }
    }

    clear(): void {
        this.#byHost.clear();
    }
}

const EMPTY: readonly ScriptInstance[] = [];
