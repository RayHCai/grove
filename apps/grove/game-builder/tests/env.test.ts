import { describe, expect, it } from 'vitest';
import { readEnv } from '../src/env.js';

const SECRET = 'e'.repeat(32);
const REQUIRED = { NODE_ENV: 'test', FLEET_SECRET: SECRET, API_URL: 'http://api.grove.internal' };

describe('the environment', () => {
    it('requires the bearer and the API, defaults the rest, and takes nothing besides', () => {
        const env = readEnv(REQUIRED);

        expect(Object.keys(env).toSorted()).toEqual([
            'API_URL',
            'AWS_REGION',
            'BUILDER_NAME',
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
        expect(() => readEnv({ ...REQUIRED, FLEET_SECRET: 'e'.repeat(31) })).toThrow(
            /bad environment/,
        );
    });

    it('leaves the stream and the bucket absent rather than defaulting either', () => {
        // A default here would be a box quietly claiming work out of somebody else's Redis, or
        // reading manifests out of a bucket nobody meant it to touch.
        const env = readEnv(REQUIRED);
        expect(env.REDIS_URL).toBeUndefined();
        expect(env.GAMES_BUCKET).toBeUndefined();
    });
});
