export type { ScriptLocation, Concurrency, EventPhase, HandlerOptions } from './types.js';
export type { HandlerDecl, HandlerDeclOpts, HandlerKind, ScriptMetadata } from './metadata.js';
export { getMetadata, getOrCreateMetadata } from './metadata.js';

export { BaseScript, ServerScript, ClientScript, SyncedScript } from './bases.js';
export type { Host } from './bases.js';

export {
    onStart,
    onEnd,
    onUpdate,
    onClick,
    onHoverEnter,
    onHoverExit,
    onPlayerJoin,
    onPlayerLeave,
    onEvent,
    onEventRelease,
    onEventHold,
    onCollide,
    onEnter,
    onExit,
    onPress,
    onRequest,
    serverState,
    defaultConcurrency,
} from './decorators.js';
