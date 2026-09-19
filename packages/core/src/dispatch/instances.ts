// Each instance carries a stable id because concurrency locks are keyed per instance —
// keyed by method alone, one player's cooldown would gate every other player's.

import type { ScriptProps } from '@platform/project';
import { defined } from '@platform/math';
import type { HandlerDecl, HandlerKind, ScriptLocation } from '../script/index.js';
import { getMetadata } from '../script/index.js';
import type { GuardOwner, ScopeId } from './scope-tree.js';

let nextInstanceId = 1;

const NO_HANDLERS: readonly HandlerDecl[] = [];
const NO_KINDS: ReadonlySet<HandlerKind> = new Set();

/**
 * Which handler kinds a class declares, memoised on the metadata array every instance of that
 * class shares — so a thousand copies of one script build the set once.
 */
const KINDS = new WeakMap<readonly HandlerDecl[], ReadonlySet<HandlerKind>>();

function kindsOf(handlers: readonly HandlerDecl[]): ReadonlySet<HandlerKind> {
    if (handlers.length === 0) return NO_KINDS;
    let kinds = KINDS.get(handlers);
    if (kinds === undefined) {
        const built = new Set<HandlerKind>();
        for (const decl of handlers) built.add(decl.kind);
        kinds = built;
        KINDS.set(handlers, kinds);
    }
    return kinds;
}

export interface ScriptInstance extends GuardOwner {
    readonly instance: object;
    readonly klass: abstract new (...args: never[]) => object;
    readonly location: ScriptLocation;
    /** Handlers this class declares, resolved from prototype-chain metadata. */
    readonly handlers: readonly HandlerDecl[];
    /** What this attachment was configured with, kept so a join snapshot can restate it. */
    readonly props?: ScriptProps;
}

/** Reads the location a script class declares via its base (`__location`). */
export function locationOf(klass: abstract new (...args: never[]) => object): ScriptLocation {
    return (klass as unknown as { __location: ScriptLocation }).__location;
}

export function makeInstance(
    instance: object,
    klass: abstract new (...args: never[]) => object,
    hostScopeId: ScopeId,
    props?: ScriptProps,
): ScriptInstance {
    const meta = getMetadata(klass);
    // The shared empty rather than a fresh one: `kindsOf` memoises against the array's identity.
    const handlers = meta?.handlers ?? NO_HANDLERS;
    return {
        id: nextInstanceId++,
        instance,
        klass,
        className: klass.name,
        location: locationOf(klass),
        handlers,
        hostScopeId,
        ...defined({ props }),
    };
}

/** One instance owed its `@onStart`, with the host key that dispatch addresses. */
export interface PendingStart {
    hostKey: string;
    inst: ScriptInstance;
}

/** The script instances attached to each host. */
export class InstanceRegistry {
    /** hostKey → its instances in attachment order, which is dispatch order. */
    readonly #byHost = new Map<string, ScriptInstance[]>();
    /** The reverse edge, for engine code holding a script object and needing its identity. */
    readonly #byInstance = new WeakMap<object, ScriptInstance>();
    /** Attached but not yet started, in attachment order; the starts pass drains this. */
    readonly #pendingStart: PendingStart[] = [];

    #onRemoved: ((instanceId: number) => void) | null = null;

    attach(hostKey: string, inst: ScriptInstance): void {
        let list = this.#byHost.get(hostKey);
        if (!list) {
            list = [];
            this.#byHost.set(hostKey, list);
        }
        list.push(inst);
        this.#byInstance.set(inst.instance, inst);
        this.#pendingStart.push({ hostKey, inst });
    }

    /** Everything attached since the last drain, in attachment order. Empties the queue. */
    takePendingStarts(): PendingStart[] {
        return this.#pendingStart.splice(0);
    }

    get pendingStartCount(): number {
        return this.#pendingStart.length;
    }

    forHost(hostKey: string): readonly ScriptInstance[] {
        return this.#byHost.get(hostKey) ?? EMPTY;
    }

    /** The registration for a script object, or undefined for one never attached. */
    forInstance(instance: object): ScriptInstance | undefined {
        return this.#byInstance.get(instance);
    }

    /** Told of every instance a host removal drops, so state keyed by instance id goes with it. */
    setOnRemoved(fn: (instanceId: number) => void): void {
        this.#onRemoved = fn;
    }

    removeHost(hostKey: string): void {
        const removed = this.#byHost.get(hostKey);
        if (removed && this.#onRemoved !== null) {
            for (const inst of removed) this.#onRemoved(inst.id);
        }
        this.#byHost.delete(hostKey);
        // A script on a torn-down host never starts: the destroy drain has already run `@onEnd`
        // for that host, and starting after ending is the one order a handler cannot be written
        // against.
        this.dropPendingStarts(hostKey);
    }

    /** Forgets one host's queued starts, for a caller that has already dispatched them. */
    dropPendingStarts(hostKey: string): void {
        for (let i = this.#pendingStart.length - 1; i >= 0; i--) {
            if (this.#pendingStart[i]?.hostKey === hostKey) this.#pendingStart.splice(i, 1);
        }
    }

    *all(): IterableIterator<ScriptInstance> {
        for (const list of this.#byHost.values()) {
            yield* list;
        }
    }

    /** Every instance paired with its host key, for a dispatch that must branch on WHICH host. */
    *entries(): IterableIterator<readonly [string, ScriptInstance]> {
        for (const [hostKey, list] of this.#byHost) {
            for (const inst of list) yield [hostKey, inst];
        }
    }

    /** The instances declaring `kind` and their host keys, into two caller-owned arrays. */
    snapshotByKind(kind: HandlerKind, hostsOut: string[], instancesOut: ScriptInstance[]): number {
        hostsOut.length = 0;
        instancesOut.length = 0;
        for (const [hostKey, list] of this.#byHost) {
            for (let i = 0; i < list.length; i++) {
                const inst = list[i]!;
                if (!kindsOf(inst.handlers).has(kind)) continue;
                hostsOut.push(hostKey);
                instancesOut.push(inst);
            }
        }
        return instancesOut.length;
    }

    /** Whether `inst`'s class declares any handler of `kind`; a coarse pre-filter. */
    declares(inst: ScriptInstance, kind: HandlerKind): boolean {
        return kindsOf(inst.handlers).has(kind);
    }

    clear(): void {
        this.#byHost.clear();
        this.#pendingStart.length = 0;
    }
}

const EMPTY: readonly ScriptInstance[] = [];
