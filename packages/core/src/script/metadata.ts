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

const METADATA_KEY = Symbol.for('@platform/core:metadata');

export function getOrCreateMetadata(metadata: DecoratorMetadataObject): ScriptMetadata {
    let existing = (metadata as Record<symbol, ScriptMetadata | undefined>)[METADATA_KEY];
    if (!existing) {
        existing = { handlers: [], state: new Set() };
        (metadata as Record<symbol, ScriptMetadata>)[METADATA_KEY] = existing;
    }
    return existing;
}

export function getMetadata(klass: abstract new (...args: never[]) => object): ScriptMetadata | undefined {
    const meta = (klass as { [Symbol.metadata]?: Record<symbol, ScriptMetadata> })[Symbol.metadata];
    return meta?.[METADATA_KEY];
}

export function ensureOwnHandlers(md: ScriptMetadata, metadata: DecoratorMetadataObject): HandlerDecl[] {
    const proto = Object.getPrototypeOf(metadata) as Record<symbol, ScriptMetadata> | null;
    const inherited = proto?.[METADATA_KEY]?.handlers;
    if (md.handlers === inherited) {
        md.handlers = inherited ? [...inherited] : [];
    }
    return md.handlers;
}

export function ensureOwnState(md: ScriptMetadata, metadata: DecoratorMetadataObject): Set<string> {
    const proto = Object.getPrototypeOf(metadata) as Record<symbol, ScriptMetadata> | null;
    const inherited = proto?.[METADATA_KEY]?.state;
    if (md.state === inherited) {
        md.state = inherited ? new Set(inherited) : new Set();
    }
    return md.state;
}
