export type { Ctx } from './ctx.js';

export { Asset, assets } from './assets.js';
export type { AssetKind, AssetRef, Assets } from './assets.js';

export { sound, music } from './audio.js';
export type { SoundHandle, SoundOptions, Sound, Music } from './audio.js';

export { random, RuntimeRandom } from './random.js';
export type { Random } from './random.js';

export { sleep, every, after } from './time.js';
export { request } from './request.js';

export { Entity } from './entity.js';
export type { Collider, Animation } from './entity.js';

export { Camera } from './camera.js';

export { HUD, HUDScreen, hud } from './hud.js';

export { Player, PlayerManager } from './player.js';
export type { Cursor, InputBindings, ActionState } from './player.js';

export { Game, RuntimeGame, WorldQuery, game } from './game.js';
export type { FindQuery } from './game.js';

export { oscillate, orbit, tween } from './motion.js';

export {
    StatefulWrapper,
    Countdown,
    Storage,
    Scoreboard,
    Leaderboard,
    Inventory,
    Team,
} from './wrappers.js';

export { BaseMovement, TopDownMovement, PlatformerMovement } from './movement.js';
export type { Movement } from './movement.js';

// ─── runtime plumbing (not creator-facing, but part of the package surface) ──────
export {
    Runtime,
    createRuntime,
    currentRuntime,
    hasRuntime,
    withRuntime,
    clearRuntime,
    CollectingLog,
} from './runtime.js';
export type { EngineLog, TickPasses } from './runtime.js';

export { loadGame } from './load-game.js';
export type { GameManifest } from './load-game.js';

export { Roster } from './roster.js';
export { RegionIndex } from './regions.js';
export { ContactSource } from './contacts.js';
export { LagRing } from './lag-ring.js';
export { Wiring, activeLocationsFor } from './wiring.js';
export { HostTable, entityKey, playerKey, GAME_KEY } from './hosts.js';

export { ManualClock, MemoryKVStore, NullEffectSink, noBlocked } from './seams.js';
export type { Clock, PhysicsSink, KVStore, EffectSink, Blocked } from './seams.js';
export { NullPhysicsSink } from './physics.js';
export { PRNGStore } from './prng-store.js';
export type { PRNGBuffer } from './prng-store.js';
