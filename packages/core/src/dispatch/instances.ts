// The attached-script registry: which script instances live on which host, and the
// handler table each contributes. A host's handler set is fully known from its attached
// scripts (DESIGN §5), which is what lets the engine reject location violations at wire
// time and keep dispatch order stable.
//
// Concurrency locks live per instance (§4.2) — not per method, the lazy implementation
// that makes player 1's cooldown gate player 2. So each instance carries a stable id.

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
    /** Handlers this class declares, resolved from prototype-chain metadata (§3.2). */
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

/** All script instances attached to one host, and the reverse lookup by scope. */
export class InstanceRegistry {
    /** hostKey → its attached instances, in attachment order (dispatch order, §5.8). */
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

    /** Every instance on every host — the wiring walk (loadGame, snapshot host records). */
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
