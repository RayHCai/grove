import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { readEnv } from '../src/env.js';

const env = readEnv({
    NODE_ENV: 'test',
    FLEET_SECRET: 'e'.repeat(32),
    API_URL: 'http://api.grove.internal',
});

describe('the health route', () => {
    it('is ok while the consumer is claiming builds', async () => {
        const app = await buildApp(env, () => ({ ok: true }));
        const response = await app.inject({ method: 'GET', url: '/health' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
    });

    it('is a 503 naming why once it is not, so a host agent replaces the box', async () => {
        const app = await buildApp(env, () => ({
            ok: false,
            reason: 'the build consumer stopped',
        }));
        const response = await app.inject({ method: 'GET', url: '/health' });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ ok: false, reason: 'the build consumer stopped' });
    });
});
