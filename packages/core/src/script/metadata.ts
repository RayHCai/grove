// The per-class decorator metadata: handler declarations and @serverState fields.
// Metadata objects inherit prototypally (Object.create(baseMetadata)), so a subclass
// inherits its parent's declarations and an override does not re-register — the
// DoubleJump rule (DESIGN §3.2). Writes are copy-on-write: a decorator finding
// `handlers` inherited rather than own clones before pushing.

import type { Concurrency, EventPhase } from './types.js';

export interface HandlerDecl {
    event: string;
    kind: HandlerKind;
    methodName: string;
    opts: HandlerDeclOpts;
}

export interface HandlerDeclOpts {
    concurrency?: Concurrency;
    on?: EventPhase;
}

export type HandlerKind =
    | 'onStart'
    | 'onEnd'
    | 'onUpdate'
    | 'onEvent'
    | 'onCollide'
    | 'onEnter'
    | 'onExit'
    | 'onClick'
    | 'onHoverEnter'
    | 'onHoverExit'
    | 'onPlayerJoin'
    | 'onPlayerLeave'
    | 'onPress'
    | 'onRequest';

export interface ScriptMetadata {
    handlers: HandlerDecl[];
    state: Set<string>;
}

// Symbol.for so a metadata record survives the src/dist dual-module split the tests use.
const METADATA_KEY = Symbol.for('@platform/core:metadata');

/**
 * The class's OWN metadata record, cloning the inherited declarations on first write —
 * copy-on-write at the record level (§3.2). A subclass declaring its first decorator forks
 * the parent's tables so a sibling's push never reaches the base. A class with no own
 * decorator has no own record and resolves its parent's through the prototype chain, which
 * is how an override that re-declares nothing inherits the parent's registration.
 */
export function getOrCreateMetadata(metadata: DecoratorMetadataObject): ScriptMetadata {
    const holder = metadata as Record<symbol, ScriptMetadata | undefined>;
    if (Object.hasOwn(metadata, METADATA_KEY)) {
        return holder[METADATA_KEY]!;
    }
    // Fork the inherited record (reached via the metadata object's prototype), or start fresh.
    const inherited = holder[METADATA_KEY];
    const own: ScriptMetadata = {
        handlers: inherited ? [...inherited.handlers] : [],
        state: inherited ? new Set(inherited.state) : new Set(),
    };
    Object.defineProperty(metadata, METADATA_KEY, {
        value: own,
        enumerable: true,
        configurable: true,
        writable: true,
    });
    return own;
}

export function getMetadata(klass: abstract new (...args: never[]) => object): ScriptMetadata | undefined {
    const meta = (klass as { [Symbol.metadata]?: Record<symbol, ScriptMetadata> })[Symbol.metadata];
    return meta?.[METADATA_KEY];
}

/** The class's own handlers table (already forked by getOrCreateMetadata). */
export function ensureOwnHandlers(md: ScriptMetadata, _metadata: DecoratorMetadataObject): HandlerDecl[] {
    return md.handlers;
}

/** The class's own state set (already forked by getOrCreateMetadata). */
export function ensureOwnState(md: ScriptMetadata, _metadata: DecoratorMetadataObject): Set<string> {
    return md.state;
}
