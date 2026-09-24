// What a creator's file is checked against, and the reason none of them carries an import: every
// name @platform/engine exports is declared here as a global, so the API is reachable by writing
// it. The compile puts the imports back (`src/project/prelude.ts`), which is the only place they
// exist — a creator never sees one, and never has to keep one in step with the code below it.
//
// It is shipped to the workbench as text and checked by `tsconfig.creator.json`, so an engine
// export that is renamed fails this package's typecheck rather than the creator's file.

import * as Engine from '@platform/engine';

declare global {
    export import clamp = Engine.clamp;
    export import lerp = Engine.lerp;

    // The 22 transcendentals @platform/math reimplements. A synced script may not reach `Math.sin`
    // at all — no two engines approximate it the same way — so these are the ones that exist here.
    export import sin = Engine.sin;
    export import cos = Engine.cos;
    export import tan = Engine.tan;
    export import asin = Engine.asin;
    export import acos = Engine.acos;
    export import atan = Engine.atan;
    export import atan2 = Engine.atan2;
    export import sinh = Engine.sinh;
    export import cosh = Engine.cosh;
    export import tanh = Engine.tanh;
    export import asinh = Engine.asinh;
    export import acosh = Engine.acosh;
    export import atanh = Engine.atanh;
    export import exp = Engine.exp;
    export import expm1 = Engine.expm1;
    export import log = Engine.log;
    export import log1p = Engine.log1p;
    export import log2 = Engine.log2;
    export import log10 = Engine.log10;
    export import pow = Engine.pow;
    export import cbrt = Engine.cbrt;
    export import hypot = Engine.hypot;

    export import BaseScript = Engine.BaseScript;
    export import ServerScript = Engine.ServerScript;
    export import ClientScript = Engine.ClientScript;
    export import SyncedScript = Engine.SyncedScript;

    export import onStart = Engine.onStart;
    export import onEnd = Engine.onEnd;
    export import onUpdate = Engine.onUpdate;
    export import onClick = Engine.onClick;
    export import onHoverEnter = Engine.onHoverEnter;
    export import onHoverExit = Engine.onHoverExit;
    export import onPlayerJoin = Engine.onPlayerJoin;
    export import onPlayerLeave = Engine.onPlayerLeave;
    export import onEvent = Engine.onEvent;
    export import onEventRelease = Engine.onEventRelease;
    export import onEventHold = Engine.onEventHold;
    export import onCollide = Engine.onCollide;
    export import onEnter = Engine.onEnter;
    export import onExit = Engine.onExit;
    export import onPress = Engine.onPress;
    export import onRequest = Engine.onRequest;
    export import serverState = Engine.serverState;

    export import Entity = Engine.Entity;
    export import Player = Engine.Player;
    export import Game = Engine.Game;
    export import Camera = Engine.Camera;
    export import HUD = Engine.HUD;
    export import HUDScreen = Engine.HUDScreen;
    export import Asset = Engine.Asset;

    export import game = Engine.game;
    export import hud = Engine.hud;
    export import random = Engine.random;
    export import assets = Engine.assets;
    export import sound = Engine.sound;
    export import music = Engine.music;

    export import sleep = Engine.sleep;
    export import every = Engine.every;
    export import after = Engine.after;

    export import oscillate = Engine.oscillate;
    export import orbit = Engine.orbit;
    export import tween = Engine.tween;

    export import request = Engine.request;

    export import StatefulWrapper = Engine.StatefulWrapper;
    export import Countdown = Engine.Countdown;
    export import Storage = Engine.Storage;
    export import Scoreboard = Engine.Scoreboard;
    export import Leaderboard = Engine.Leaderboard;
    export import Inventory = Engine.Inventory;
    export import Team = Engine.Team;

    export import BaseMovement = Engine.BaseMovement;
    export import TopDownMovement = Engine.TopDownMovement;
    export import PlatformerMovement = Engine.PlatformerMovement;

    // Type-only exports, which an import alias may not name; each is restated with its parameters.
    type Vec3 = Engine.Vec3;
    type Bounds = Engine.Bounds;
    type Easing = Engine.Easing;
    type Ctx = Engine.Ctx;
    type FindQuery = Engine.FindQuery;
    type Cursor = Engine.Cursor;
    type InputBindings = Engine.InputBindings;
    type ActionState = Engine.ActionState;
    type Collider = Engine.Collider;
    type Animation = Engine.Animation;
    type HUDAnchor = Engine.HUDAnchor;
    type AssetKind = Engine.AssetKind;
    type AssetRef = Engine.AssetRef;
    type SoundHandle = Engine.SoundHandle;
    type SoundOptions = Engine.SoundOptions;
    type Random = Engine.Random;
    type Movement = Engine.Movement;
    type Concurrency = Engine.Concurrency;
    type EventPhase = Engine.EventPhase;
    type HandlerOptions = Engine.HandlerOptions;
    type HandlerDecorator = Engine.HandlerDecorator;
    type StateDecorator = Engine.StateDecorator;
    type Host = Engine.Host;
    type ScriptQuery<T> = Engine.ScriptQuery<T>;

    /**
     * What a run forwards to the console pane.
     *
     * Declared here rather than taken from the DOM library, which a creator's program is compiled
     * without: `window`, `document` and the rest exist on one end only, and the two names this
     * engine and that library share — `Storage` and `Animation` — would collide outright.
     */
    const console: {
        log(...values: unknown[]): void;
        info(...values: unknown[]): void;
        warn(...values: unknown[]): void;
        error(...values: unknown[]): void;
    };
}
