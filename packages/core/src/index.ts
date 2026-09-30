// Enumerated, not `export *`: adding an export to a module must not widen what core publishes.

export { BREAKER_THRESHOLD, MAX_REWIND_MS, resolveConfig } from './config.js';
export type { EngineConfig } from './config.js';

export { LoadError } from './errors.js';
export type { BreakerTrip } from './errors.js';

export { NO_ENTITY } from './ids.js';
export type { EntityId } from './ids.js';

export { Loop } from './loop/loop.js';
export type { Snapshot, SnapshotStore } from './loop/store-registry.js';

export type { AnyScriptClass } from './world/templates.js';
export type { TransformBuffer } from './world/transform-store.js';

export type { HostRecord } from './state/host-record.js';
export type { SingleStructuralOp, StateMark, StructuralOp } from './state/channels.js';
export { hoistReplicated } from './state/backing.js';

export {
    BaseScript,
    ServerScript,
    ClientScript,
    SyncedScript,
    getMetadata,
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
} from './script/index.js';
export type {
    Concurrency,
    EventPhase,
    HandlerDecorator,
    HandlerOptions,
    Host,
    ScriptLocation,
    ScriptMetadata,
    StateDecorator,
} from './script/index.js';

export type { DispatchOptions } from './dispatch/dispatcher.js';

export {
    MOVE_AXES,
    dispatchInput,
    foldInputEdges,
    inputHostKeys,
    isAvatarOf,
    stepMovements,
    synthesizeHolds,
} from './input-fold.js';

export type { Ctx } from './runtime/ctx.js';
export { Asset, AssetRegistry, assets } from './runtime/assets.js';
export type { AssetKind, AssetRef } from './runtime/assets.js';
export { sound, music } from './runtime/audio.js';
export type { SoundHandle, SoundOptions } from './runtime/audio.js';
export { random } from './runtime/random.js';
export type { Random } from './runtime/random.js';
export { sleep, every, after } from './runtime/time.js';
export { request } from './runtime/request.js';
export { Entity } from './runtime/entity.js';
export type { Collider, Animation } from './runtime/entity.js';
export { Camera } from './runtime/camera.js';
export { HUD, HUDScreen, hud } from './runtime/hud.js';
export type { HUDAnchor } from './runtime/hud.js';
export { Player } from './runtime/player.js';
export type { Cursor, InputBindings, ActionState } from './runtime/player.js';
export { createActionStates } from './runtime/action-states.js';
export type { ActionStates } from './runtime/action-states.js';
export { Game, game } from './runtime/game.js';
export type { FindQuery } from './runtime/game.js';
export { oscillate, orbit, tween } from './runtime/motion.js';
export {
    StatefulWrapper,
    Countdown,
    Storage,
    Scoreboard,
    Leaderboard,
    Inventory,
    Team,
    restoreHostField,
    serializeHostField,
} from './runtime/wrappers.js';
export type { WrapperKind } from './runtime/wrappers.js';
export { PERSISTENCE_SCOPE } from './runtime/persistence.js';
export { BaseMovement, TopDownMovement, PlatformerMovement } from './runtime/movement.js';
export type { Movement } from './runtime/movement.js';
export {
    Runtime,
    currentRuntime,
    hasRuntime,
    withRuntime,
    clearRuntime,
} from './runtime/runtime.js';
export type { LogSink, TickPasses } from './runtime/runtime.js';
export {
    loadGame,
    startGame,
    endGame,
    joinPlayer,
    leavePlayer,
    pressWidget,
    pointerHit,
    deliverRequest,
    displayUpdate,
} from './runtime/load-game.js';
export type { GameManifest, PlayerRequest, PointerEdge } from './runtime/load-game.js';
export { activeLocationsFor } from './runtime/wiring.js';
export { GAME_KEY, entityKey, playerKey } from './runtime/hosts.js';
export { MemoryKVStore } from './runtime/seams.js';
export type { HUDSink, HUDWidgetState, KVStore } from './runtime/seams.js';
export type { ScriptQuery } from './runtime/get-script.js';
