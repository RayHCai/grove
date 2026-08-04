// @platform/engine
// Public @platform/engine entry point. Re-exports the creator API.

// Shell package: the public surface lands here.
export const PACKAGE_NAME = '@platform/engine';

// The primitives are IMPLEMENTED in @platform/math and re-exported here, so the
// creator-facing names in api_spec.ts (`Vec3` at :48, `Bounds` at :57, `clamp` at :82,
// `lerp` at :83) each resolve to exactly one type. A creator has one import; the split is
// internal (api_design.md §11.1).
export type { Vec3, Vec3Like, Bounds, Size, Easing } from '@platform/math';
export { clamp, lerp } from '@platform/math';

// Deterministic replacements for the approximated Math functions (§9.1). Creators
// reach for these through the one engine import; a SyncedScript must, since Math.* is
// a load-time error there.
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
    AssetKind,
    AssetRef,
    SoundHandle,
    SoundOptions,
    Random,
    Movement,
    Concurrency,
    EventPhase,
    HandlerOptions,
    Host,
} from '@platform/core';
