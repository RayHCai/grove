// The same arithmetic runs once on each side, so the only way the two answers match bit for bit is
// that both reached the deterministic implementations rather than whatever `Math` the host has.

import type { Ctx, Game, HUDScreen } from '@platform/engine';
import {
    ClientScript,
    ServerScript,
    acos,
    acosh,
    asin,
    asinh,
    atan,
    atan2,
    atanh,
    cbrt,
    cos,
    cosh,
    exp,
    expm1,
    hud,
    hypot,
    lerp,
    log,
    log10,
    log1p,
    log2,
    onPlayerJoin,
    onPress,
    pow,
    serverState,
    sin,
    sinh,
    tan,
    tanh,
} from '@platform/engine';
import { TEMPLATE_AVATAR, attach, defineWorld, sprite } from '../world.js';
import type { World } from '../world.js';

export const SCRIPT_CALCULATOR = 'calculator';
export const SCRIPT_ABACUS = 'abacus';

export const SCREEN_ABACUS = 'abacus';
export const WIDGET_COMPUTE = 'compute';
/** Where the client-located handler writes its own answer. */
export const WIDGET_ANSWER = 'answer';

/** Inside every function's domain; `acosh` is fed `1 + X` since it is undefined below one. */
export const X = 0.7;
export const Y = 1.3;
export const LERP_FROM = -3;
export const LERP_TO = 5;

export const S = { digest: 'digest' } as const;

/** Every result at full precision, so a divergence in the low bits is not rounded away. */
export function digestOf(): string {
    return [
        lerp(LERP_FROM, LERP_TO, X),
        sin(X),
        cos(X),
        tan(X),
        asin(X),
        acos(X),
        atan(X),
        atan2(Y, -X),
        sinh(X),
        cosh(X),
        tanh(X),
        asinh(X),
        acosh(1 + X),
        atanh(X),
        exp(X),
        expm1(X),
        log(X),
        log1p(X),
        log2(X),
        log10(X),
        pow(X, Y),
        cbrt(X),
        hypot(X, Y),
    ]
        .map(String)
        .join('|');
}

export class Calculator extends ServerScript<Game> {
    @serverState digest = '';

    @onPlayerJoin
    join(ctx: Ctx): void {
        ctx.player?.spawn();
    }

    @onPress(WIDGET_COMPUTE)
    compute(): void {
        this.digest = digestOf();
    }
}

/** The client half: the same press runs here on the mirror, against the client's own engine. */
export class Abacus extends ClientScript<HUDScreen> {
    @onPress(WIDGET_COMPUTE)
    compute(): void {
        hud.text(WIDGET_ANSWER, digestOf());
    }
}

export const MATH_WORLD: World = defineWorld({
    id: 'math',
    scripts: [
        {
            id: SCRIPT_CALCULATOR,
            export: 'Calculator',
            path: 'src/worlds/math.ts',
            location: 'server',
            host: 'game',
            ctor: Calculator,
        },
        {
            id: SCRIPT_ABACUS,
            export: 'Abacus',
            path: 'src/worlds/math.ts',
            location: 'client',
            host: 'screen',
            ctor: Abacus,
        },
    ],
    templates: [sprite(TEMPLATE_AVATAR)],
    gameScripts: [attach(SCRIPT_CALCULATOR)],
    screens: [{ name: SCREEN_ABACUS, script: Abacus as never }],
});
