// The built-in movement types, installed on a real avatar and driven by real keys.
//
// A movement class is named in no attachment list here: the roster installs one when `setMovement`
// names it, and the `attach` op that produces is what tells a tab to build its own copy. Every
// widget below therefore acts on `player.movement` — the instance the roster made — and never on
// anything this file constructs.
//
// The readings are Player-hosted `@serverState`, republished every tick, so each assertion is made
// against what one tab was told about its OWN body rather than against the authority's field.

import type { Ctx, Game, Movement, Player, Vec3 } from '@platform/engine';
import {
    BaseMovement,
    PlatformerMovement,
    ServerScript,
    TopDownMovement,
    onPlayerJoin,
    onPress,
    onUpdate,
    serverState,
} from '@platform/engine';
import { SIM_RATE, TEMPLATE_AVATAR, attach, defineWorld, sprite } from '../world.js';
import type { StageBinding, World } from '../world.js';

/** Where a joining avatar is put, so every distance below is known before the run. */
export const AVATAR_AT = { x: 0, y: 0 };

/** The two axes core's input pass folds into `fillIntent`, and the button a platformer jumps on. */
export const ACTION_MOVE_X = 'moveX';
export const ACTION_MOVE_Y = 'moveY';
export const ACTION_JUMP = 'jump';

export const CODE_RIGHT = 'KeyD';
export const CODE_UP = 'KeyW';
export const CODE_JUMP = 'Space';

export const SCRIPT_DIRECTOR = 'director';
export const SCRIPT_TELEMETRY = 'telemetry';
export const SCRIPT_DRIFTER = 'drifter';
export const SCRIPT_WALKER = 'walker';
export const SCRIPT_RUNNER = 'runner';
export const SCRIPT_FAULTY = 'faulty';

/** Speeds are per second and steps are per tick, so an expected distance is arithmetic. */
export const DRIFT_SPEED = 60;
export const DRIFT_CAP = 200;
/** Over the cap on both axes, in 3:4:5, so the clamped result is a ratio a reader can check. */
export const LAUNCH = { x: 300, y: 400 };
export const CLAMPED = { x: 120, y: 160 };
export const IMPULSE_X = 30;
export const FORCE_X = 600;
export const GRIP = 120;

export const WALK_SPEED = 120;
/** Above what a diagonal reaches, so a two-key press is never the clamp that is tested elsewhere. */
export const WALK_CAP = 300;

export const RUN_SPEED = 120;
export const RUN_ACCEL = 1200;
/** Far below the acceleration, so a body that coasts to a stop cannot be mistaken for one that snapped. */
export const RUN_FRICTION = 60;
export const GRAVITY = 600;
export const JUMP_STRENGTH = 120;

/** What one tick of each rate is worth, since that is the unit every assertion is made in. */
export const WALK_STEP = WALK_SPEED / SIM_RATE;
export const FORCE_STEP = FORCE_X / SIM_RATE;
export const ACCEL_STEP = RUN_ACCEL / SIM_RATE;

/** The stages `tick` runs, in the order both endpoints are meant to replay them. */
export const STAGE_ORDER = 'readIntent>accelerate>applyForces>clampSpeed';

export const MOVER_NONE = 'none';
export const MOVER_DRIFT = 'drifter';
export const MOVER_WALK = 'walker';
export const MOVER_RUN = 'runner';
export const MOVER_FAULT = 'faulty';

/** One widget per verb: a press names the call, and the reading names what it did. */
export const W = {
    drift: 'use-drifter',
    walk: 'use-walker',
    run: 'use-runner',
    fault: 'use-faulty',
    push: 'push',
    launch: 'launch',
    impulse: 'impulse',
    force: 'force',
    grip: 'grip',
    aim: 'aim',
    halt: 'halt',
    off: 'off',
    on: 'on',
} as const;

/** Replicated readings, named so none of them collides with a member `Player` already owns. */
export const S = {
    mover: 'mover',
    vx: 'vx',
    vy: 'vy',
    ix: 'ix',
    iy: 'iy',
    pace: 'pace',
    cap: 'cap',
    floor: 'floor',
    stages: 'stages',
    lift: 'lift',
    first: 'first',
} as const;

/**
 * A body with momentum: the one stage every subclass must supply, supplying nothing.
 *
 * `accelerate` is what would otherwise overwrite a velocity a handler set, so leaving it alone is
 * what makes `setVelocity`, `impulse` and `addForce` observable for longer than the tick they ran on.
 */
export class Drifter extends BaseMovement {
    override maxSpeed = DRIFT_CAP;
    /** Speed change per second toward the intent; zero leaves the body on whatever it was given. */
    grip = 0;

    protected accelerate(intent: Vec3, dt: number): void {
        if (this.grip === 0) return;
        this.setVelocity(
            this.approach(this.velocity.x, intent.x * this.maxSpeed, this.grip * dt),
            this.velocity.y,
        );
    }
}

/** Top-down, plus a record of which stages ran and in what order. */
export class Walker extends TopDownMovement {
    override walkSpeed = WALK_SPEED;
    override maxSpeed = WALK_CAP;

    /** Rebuilt every tick, so a reading of it is a claim about the tick it was read on. */
    order = '';

    protected override readIntent(): Vec3 {
        this.order = 'readIntent';
        return super.readIntent();
    }

    protected override accelerate(intent: Vec3): void {
        this.order = `${this.order}>accelerate`;
        super.accelerate(intent);
    }

    protected override applyForces(dt: number): void {
        this.order = `${this.order}>applyForces`;
        super.applyForces(dt);
    }

    protected override clampSpeed(): void {
        this.order = `${this.order}>clampSpeed`;
        super.clampSpeed();
    }
}

export class Runner extends PlatformerMovement {
    override walkSpeed = RUN_SPEED;
    override acceleration = RUN_ACCEL;
    override friction = RUN_FRICTION;
    override gravity = GRAVITY;
    override jumpStrength = JUMP_STRENGTH;
}

/** Throws in the one stage a subclass must supply, so the movement pass has something to contain. */
export class Faulty extends TopDownMovement {
    protected override accelerate(): void {
        throw new Error('accelerate refused');
    }
}

/** By class rather than by `klass.name`, which a bundler is free to rewrite. */
function nameOf(movement: Movement): string {
    if (movement instanceof Walker) return MOVER_WALK;
    if (movement instanceof Runner) return MOVER_RUN;
    if (movement instanceof Drifter) return MOVER_DRIFT;
    return MOVER_FAULT;
}

/**
 * One player's body, as that player's own tab is told about it.
 *
 * Player-hosted rather than Game-hosted because a velocity belongs to one body: a Game field would
 * carry whichever player wrote last, and this suite is about what a tab knows of ITSELF.
 */
export class Telemetry extends ServerScript<Player> {
    @serverState mover = MOVER_NONE;
    @serverState vx = 0;
    @serverState vy = 0;
    @serverState ix = 0;
    @serverState iy = 0;
    @serverState pace = 0;
    @serverState cap = 0;
    @serverState floor = false;
    @serverState stages = '';
    /** Latched, because a jump is one tick wide and the wire samples at a third of the tick rate. */
    @serverState lift = 0;
    /** The first non-zero horizontal speed, which is one acceleration step and nothing more. */
    @serverState first = 0;

    @onUpdate
    publish(): void {
        const movement = this.host.movement;
        if (!movement) return;
        const velocity = movement.velocity;
        const intent = movement.intent;
        this.mover = nameOf(movement);
        this.vx = velocity.x;
        this.vy = velocity.y;
        this.ix = intent.x;
        this.iy = intent.y;
        this.pace = movement.speed;
        this.cap = movement.maxSpeed;
        this.floor = movement.blocked.down;
        this.stages = movement instanceof Walker ? movement.order : '';
        // Republished rather than written on change: only a write marks the channel, and a latch
        // that never fired would otherwise be a field the wire never carried at all.
        this.lift = velocity.y > this.lift ? velocity.y : this.lift;
        this.first = this.first === 0 ? velocity.x : this.first;
    }
}

export class Director extends ServerScript<Game> {
    /** Spawned with no movement at all: `setMovement` is the only thing that installs one. */
    @onPlayerJoin
    join(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        player.spawn();
        player.teleportTo(AVATAR_AT.x, AVATAR_AT.y);
        player.addScript(Telemetry);
    }

    @onPress(W.drift)
    useDrifter(ctx: Ctx): void {
        ctx.player?.setMovement(Drifter);
    }

    @onPress(W.walk)
    useWalker(ctx: Ctx): void {
        ctx.player?.setMovement(Walker);
    }

    @onPress(W.run)
    useRunner(ctx: Ctx): void {
        ctx.player?.setMovement(Runner);
    }

    @onPress(W.fault)
    useFaulty(ctx: Ctx): void {
        ctx.player?.setMovement(Faulty);
    }

    @onPress(W.push)
    push(ctx: Ctx): void {
        ctx.player?.movement?.setVelocity(DRIFT_SPEED, 0);
    }

    @onPress(W.launch)
    launch(ctx: Ctx): void {
        ctx.player?.movement?.setVelocity(LAUNCH.x, LAUNCH.y);
    }

    @onPress(W.impulse)
    shove(ctx: Ctx): void {
        ctx.player?.movement?.impulse(IMPULSE_X, 0);
    }

    @onPress(W.force)
    blow(ctx: Ctx): void {
        ctx.player?.movement?.addForce(FORCE_X, 0);
    }

    @onPress(W.grip)
    brake(ctx: Ctx): void {
        const movement = ctx.player?.movement;
        if (movement instanceof Drifter) movement.grip = GRIP;
    }

    @onPress(W.aim)
    aim(ctx: Ctx): void {
        ctx.player?.movement?.setIntent(1, 0);
    }

    @onPress(W.halt)
    halt(ctx: Ctx): void {
        ctx.player?.movement?.stop();
    }

    @onPress(W.off)
    disable(ctx: Ctx): void {
        const movement = ctx.player?.movement;
        if (movement) movement.enabled = false;
    }

    @onPress(W.on)
    enable(ctx: Ctx): void {
        const movement = ctx.player?.movement;
        if (movement) movement.enabled = true;
    }
}

/** A button bound to a move axis reads as full deflection while it is held, and zero once it is not. */
export const BINDINGS: StageBinding[] = [
    { kind: 'button', code: CODE_RIGHT, action: ACTION_MOVE_X },
    { kind: 'button', code: CODE_UP, action: ACTION_MOVE_Y },
    { kind: 'button', code: CODE_JUMP, action: ACTION_JUMP },
];

const PATH = 'src/worlds/movement.ts';

export const MOVEMENT_WORLD: World = defineWorld({
    id: 'movement',
    scripts: [
        {
            id: SCRIPT_DIRECTOR,
            export: 'Director',
            path: PATH,
            location: 'server',
            host: 'game',
            ctor: Director,
        },
        {
            id: SCRIPT_TELEMETRY,
            export: 'Telemetry',
            path: PATH,
            location: 'server',
            host: 'player',
            ctor: Telemetry,
        },
        // Synced, and that is the whole reason a movement type is one class rather than two: the
        // authority runs it and the wire tells every tab to build the same one.
        {
            id: SCRIPT_DRIFTER,
            export: 'Drifter',
            path: PATH,
            location: 'synced',
            host: 'entity',
            ctor: Drifter,
        },
        {
            id: SCRIPT_WALKER,
            export: 'Walker',
            path: PATH,
            location: 'synced',
            host: 'entity',
            ctor: Walker,
        },
        {
            id: SCRIPT_RUNNER,
            export: 'Runner',
            path: PATH,
            location: 'synced',
            host: 'entity',
            ctor: Runner,
        },
        {
            id: SCRIPT_FAULTY,
            export: 'Faulty',
            path: PATH,
            location: 'synced',
            host: 'entity',
            ctor: Faulty,
        },
    ],
    templates: [sprite(TEMPLATE_AVATAR)],
    gameScripts: [attach(SCRIPT_DIRECTOR)],
    bindings: BINDINGS,
});
