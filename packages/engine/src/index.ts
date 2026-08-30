// @platform/engine
// The one import a creator's script sees: the runtime API core owns, and the primitives math owns.
//
// The composition roots that stand a game up are behind `@platform/engine/host`, so a chunk that
// resolves this specifier never reaches the server, the client or the renderer through it.

// The primitives are IMPLEMENTED in @platform/math and re-exported here, so each creator-facing
// name resolves to exactly one type. A creator has one import; the split is internal.
export type { Vec3, Bounds, Easing } from '@platform/math';
export { clamp, lerp } from '@platform/math';

// Deterministic replacements for the Math functions every engine approximates. A SyncedScript must
// reach them through this import, since Math.* is a load-time error there. These 22 names in this
// order are pinned against @platform/math and .oxlintrc.json, so editing the block is a
// cross-package change.
export {
    sin,
    cos,
    tan,
    asin,
    acos,
    atan,
    atan2,
    sinh,
    cosh,
    tanh,
    asinh,
    acosh,
    atanh,
    exp,
    expm1,
    log,
    log1p,
    log2,
    log10,
    pow,
    cbrt,
    hypot,
} from '@platform/math';

// The full runtime API from core.
export {
    // Script bases
    BaseScript,
    ServerScript,
    ClientScript,
    SyncedScript,

    // Decorators
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

    // Runtime objects and consts
    Entity,
    Player,
    Game,
    Camera,
    HUD,
    HUDScreen,
    Asset,

    // Ambient consts
    game,
    hud,
    random,
    assets,
    sound,
    music,

    // Time
    sleep,
    every,
    after,

    // Motion helpers
    oscillate,
    orbit,
    tween,

    // Request
    request,

    // Data wrappers
    StatefulWrapper,
    Countdown,
    Storage,
    Scoreboard,
    Leaderboard,
    Inventory,
    Team,

    // Movement
    BaseMovement,
    TopDownMovement,
    PlatformerMovement,
} from '@platform/core';

export type {
    // Types
    Ctx,
    FindQuery,
    Cursor,
    InputBindings,
    ActionState,
    Collider,
    Animation,
    HUDAnchor,
    AssetKind,
    AssetRef,
    SoundHandle,
    SoundOptions,
    Random,
    Movement,
    Concurrency,
    EventPhase,
    HandlerOptions,
    HandlerDecorator,
    StateDecorator,
    Host,
} from '@platform/core';
