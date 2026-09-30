// The expected digest is computed here from `@platform/math` directly, the package the engine
// re-exports, so a handler that reached the host's `Math` instead would disagree in the low bits.

import { describe, expect, it } from 'vitest';
import * as M from '@platform/math';
import { gameField, openWorld, reading, SETTLE } from './harness.js';
import {
    LERP_FROM,
    LERP_TO,
    MATH_WORLD,
    S,
    SCREEN_ABACUS,
    WIDGET_ANSWER,
    WIDGET_COMPUTE,
    X,
    Y,
} from '../dist/worlds/math.js';

const open = (): ReturnType<typeof openWorld> => openWorld(MATH_WORLD);

const EXPECTED = [
    M.lerp(LERP_FROM, LERP_TO, X),
    M.sin(X),
    M.cos(X),
    M.tan(X),
    M.asin(X),
    M.acos(X),
    M.atan(X),
    M.atan2(Y, -X),
    M.sinh(X),
    M.cosh(X),
    M.tanh(X),
    M.asinh(X),
    M.acosh(1 + X),
    M.atanh(X),
    M.exp(X),
    M.expm1(X),
    M.log(X),
    M.log1p(X),
    M.log2(X),
    M.log10(X),
    M.pow(X, Y),
    M.cbrt(X),
    M.hypot(X, Y),
]
    .map(String)
    .join('|');

describe('lerp and the deterministic transcendentals in a handler', () => {
    it('answer on the authority what @platform/math answers, and the mirror is told it', async () => {
        const { session, tab } = await open();
        expect(reading<string>(tab, S.digest)).toBe('');

        session.press(tab, WIDGET_COMPUTE, SCREEN_ABACUS);
        await session.step(SETTLE);

        const authority = gameField<string>(session.sim.runtime, S.digest);
        expect(authority).toBe(EXPECTED);
        expect(reading<string>(tab, S.digest)).toBe(authority);
        // Twenty-three finite values, so agreement is not two NaNs or two empty strings matching.
        const values = (authority ?? '').split('|').map(Number);
        expect(values).toHaveLength(23);
        for (const value of values) expect(Number.isFinite(value)).toBe(true);
        expect(session.trips).toEqual([]);
    });

    it('answer the same bits when a client-located handler computes them itself', async () => {
        const { session, tab } = await open();
        session.press(tab, WIDGET_COMPUTE, SCREEN_ABACUS);
        await session.step(SETTLE);

        // Written by the screen script on the mirror, never replicated: the client did this sum.
        expect(tab.client.hud.widgetOf(WIDGET_ANSWER)?.text).toBe(EXPECTED);
        expect(tab.client.hud.widgetOf(WIDGET_ANSWER)?.text).toBe(
            gameField<string>(session.sim.runtime, S.digest),
        );
    });
});
