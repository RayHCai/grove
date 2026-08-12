// Metadata objects inherit prototypally, so a subclass sees its parent's declarations and an
// override re-registers nothing; writes fork the inherited record so a sibling never reaches
// the base.

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

// Symbol.for because a record must be found across the src and dist copies the tests load.
const METADATA_KEY = Symbol.for('@platform/core:metadata');

/** The class's own metadata record, forking the inherited declarations on first write. */
export function getOrCreateMetadata(metadata: DecoratorMetadataObject): ScriptMetadata {
    const holder = metadata as Record<symbol, ScriptMetadata | undefined>;
    if (Object.hasOwn(metadata, METADATA_KEY)) {
        return holder[METADATA_KEY]!;
    }
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

export function getMetadata(
    klass: abstract new (...args: never[]) => object,
): ScriptMetadata | undefined {
    const meta = (klass as { [Symbol.metadata]?: Record<symbol, ScriptMetadata> })[Symbol.metadata];
    return meta?.[METADATA_KEY];
}

/** The class's own handlers table — getOrCreateMetadata already forked it. */
export function ensureOwnHandlers(
    md: ScriptMetadata,
    _metadata: DecoratorMetadataObject,
): HandlerDecl[] {
    return md.handlers;
}

/** The class's own state set — getOrCreateMetadata already forked it. */
export function ensureOwnState(
    md: ScriptMetadata,
    _metadata: DecoratorMetadataObject,
): Set<string> {
    return md.state;
}
