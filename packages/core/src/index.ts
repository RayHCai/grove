// Entities, world, script model, dispatch. No rendering, no network.
// Enumerated, not `export *`: adding a name to a sub-barrel must not widen what core publishes.

export { BREAKER_THRESHOLD, MAX_REWIND_MS, resolveConfig } from './config.js';
export type { EngineConfig } from './config.js';

export { LoadError } from './errors.js';
export type { BreakerTrip } from './errors.js';

export { NO_ENTITY } from './ids.js';
export type { EntityId } from './ids.js';

export { Loop } from './loop/index.js';
export type { Snapshot, SnapshotStore } from './loop/index.js';

export type { AnyScriptClass, TransformBuffer } from './world/index.js';

export type { HostRecord, SingleStructuralOp, StateMark, StructuralOp } from './state/index.js';
export { hoistReplicated } from './state/index.js';

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

export type { DispatchOptions } from './dispatch/index.js';

export {
    Asset,
    AssetRegistry,
    assets,
    sound,
    music,
    random,
    sleep,
    every,
    after,
    request,
    Entity,
    Camera,
    HUD,
    HUDScreen,
    hud,
    Player,
    createActionStates,
    Game,
    game,
    oscillate,
    orbit,
    tween,
    StatefulWrapper,
    Countdown,
    Storage,
    Scoreboard,
    Leaderboard,
    Inventory,
    Team,
    restoreHostField,
    serializeHostField,
    PERSISTENCE_SCOPE,
    PersistedState,
    BaseMovement,
    TopDownMovement,
    PlatformerMovement,
    tickMovement,
    Runtime,
    currentRuntime,
    hasRuntime,
    withRuntime,
    clearRuntime,
    loadGame,
    startGame,
    joinPlayer,
    leavePlayer,
    pressWidget,
    pointerHit,
    displayUpdate,
    activeLocationsFor,
    GAME_KEY,
    entityKey,
    playerKey,
    MemoryKVStore,
} from './runtime/index.js';
export type {
    ActionState,
    ActionStates,
    Animation,
    AssetKind,
    AssetRef,
    Collider,
    Ctx,
    Cursor,
    FindQuery,
    GameManifest,
    HUDAnchor,
    HUDSink,
    HUDWidgetState,
    InputBindings,
    KVStore,
    LogSink,
    Movement,
    PointerEdge,
    Random,
    ScriptQuery,
    SoundHandle,
    SoundOptions,
    TickPasses,
    WrapperKind,
} from './runtime/index.js';
