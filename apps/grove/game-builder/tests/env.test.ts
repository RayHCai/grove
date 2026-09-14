// What a build box reads before it will run, and what it refuses to start on.

import { describe, expect, it } from 'vitest';
import { readEnv } from '../src/env.js';

const SECRET = 'e'.repeat(32);

describe('the environment', () => {
    it('requires the bearer, defaults the rest, and takes nothing besides', () => {
        const env = readEnv({ NODE_ENV: 'test', FLEET_SECRET: SECRET });

        expect(Object.keys(env).toSorted()).toEqual([
            'BUILD_TIMEOUT_MS',
            'FLEET_SECRET',
            'GAME_BUILDER_HOST',
            'GAME_BUILDER_PORT',
            'NODE_ENV',
        ]);
        expect(env.GAME_BUILDER_HOST).toBe('127.0.0.1');
        expect(env.GAME_BUILDER_PORT).toBe(4002);
        expect(env.BUILD_TIMEOUT_MS).toBe(900_000);
    });

    it('refuses a bearer short enough to be guessed', () => {
        expect(() => readEnv({ NODE_ENV: 'test', FLEET_SECRET: 'e'.repeat(31) })).toThrow(
            /bad environment/,
        );
    });
});
