// Each instance carries a stable id because concurrency locks are keyed per instance —
// keyed by method alone, one player's cooldown would gate every other player's.

import type { HandlerDecl, ScriptLocation } from '../script/index.js';
import { getMetadata } from '../script/index.js';
import type { ScopeId } from './scope-tree.js';

let nextInstanceId = 1;

export interface ScriptInstance {
    readonly id: number;
    readonly instance: object;
    readonly klass: abstract new (...args: never[]) => object;
    readonly className: string;
    readonly location: ScriptLocation;
    /** Handlers this class declares, resolved from prototype-chain metadata. */
    readonly handlers: readonly HandlerDecl[];
    /** The host's scope-tree id, for cancellation and timer/tween ownership. */
    readonly hostScopeId: ScopeId;
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

    attach(hostKey: string, inst: ScriptInstance): void {
        let list = this.#byHost.get(hostKey);
        if (!list) {
            list = [];
            this.#byHost.set(hostKey, list);
        }
        list.push(inst);
    }

    forHost(hostKey: string): readonly ScriptInstance[] {
        return this.#byHost.get(hostKey) ?? EMPTY;
    }

    removeHost(hostKey: string): void {
        this.#byHost.delete(hostKey);
    }

    *all(): IterableIterator<ScriptInstance> {
        for (const list of this.#byHost.values()) {
            yield* list;
        }
    }

    clear(): void {
        this.#byHost.clear();
    }
}

const EMPTY: readonly ScriptInstance[] = [];
