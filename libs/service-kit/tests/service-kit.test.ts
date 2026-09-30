import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { z } from 'zod';
import { REQUEST_ID_HEADER } from '@grove/api-contract';
import {
    fleetCall,
    installServiceHandlers,
    parseEnv,
    serviceOptions,
    withPlatformPort,
} from '../src/index.js';

describe('parseEnv', () => {
    const Schema = z.object({ A: z.string().min(2), B: z.coerce.number().default(7) });

    it('answers the parsed value, defaults included', () => {
        expect(parseEnv(Schema, { A: 'xy' })).toEqual({ A: 'xy', B: 7 });
    });

    it('names every bad variable in one refusal', () => {
        expect(() => parseEnv(Schema, { A: 'x', B: 'nope' })).toThrow(
            /bad environment[\s\S]*A[\s\S]*B/u,
        );
    });
});

describe('withPlatformPort', () => {
    const names = { host: 'SVC_HOST', port: 'SVC_PORT' };

    it('leaves a source with no assigned port alone', () => {
        const source = { SVC_HOST: '127.0.0.1' };
        expect(withPlatformPort(source, names)).toBe(source);
    });

    it('listens on the assigned port, on every interface', () => {
        expect(withPlatformPort({ PORT: '8080' }, names)).toMatchObject({
            SVC_PORT: '8080',
            SVC_HOST: '0.0.0.0',
        });
    });

    it('lets what the deploy set itself win', () => {
        expect(
            withPlatformPort({ PORT: '8080', SVC_PORT: '4000', SVC_HOST: '::' }, names),
        ).toMatchObject({ SVC_PORT: '4000', SVC_HOST: '::' });
    });
});

async function served() {
    const app = Fastify({ ...serviceOptions('test'), logger: false });
    installServiceHandlers(app);
    app.get('/boom', async () => {
        throw new Error('secret detail');
    });
    app.get('/ok', async () => ({ ok: true }));
    return app;
}

describe('a service', () => {
    it('keeps a correlation id a caller presented, and mints one otherwise', async () => {
        const app = await served();
        const kept = await app.inject({ url: '/ok', headers: { [REQUEST_ID_HEADER]: 'abc-123' } });
        expect(kept.headers[REQUEST_ID_HEADER]).toBe('abc-123');

        const minted = await app.inject({ url: '/ok', headers: { [REQUEST_ID_HEADER]: 'a b' } });
        expect(minted.headers[REQUEST_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/u);
    });

    it('answers a failure in the shared shape without its detail', async () => {
        const app = await served();
        const boom = await app.inject({ url: '/boom' });
        expect(boom.statusCode).toBe(500);
        expect(boom.json()).toEqual({ code: 'internal', message: 'internal error' });

        const missing = await app.inject({ url: '/nowhere' });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toEqual({ code: 'not_found', message: 'no such route' });
    });
});

describe('fleetCall', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('carries the bearer, the correlation id and the caller headers to the peer', async () => {
        const seen: { url: string; headers: Headers; signal: AbortSignal | null | undefined }[] =
            [];
        vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
            seen.push({ url, headers: new Headers(init.headers), signal: init.signal });
            return new Response(null, { status: 204 });
        });

        const call = fleetCall({
            baseUrl: 'http://peer/',
            secret: 's'.repeat(32),
            timeoutMs: 1000,
        });
        const answered = await call('/v1/x', 'req-1', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
        });

        expect(answered.status).toBe(204);
        expect(seen[0]?.url).toBe('http://peer/v1/x');
        expect(seen[0]?.headers.get('authorization')).toBe(`Bearer ${'s'.repeat(32)}`);
        expect(seen[0]?.headers.get(REQUEST_ID_HEADER)).toBe('req-1');
        expect(seen[0]?.headers.get('content-type')).toBe('application/json');
        expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
    });

    it('rejects as fetch does when the peer is unreachable', async () => {
        vi.stubGlobal('fetch', async () => {
            throw new TypeError('fetch failed');
        });
        const call = fleetCall({ baseUrl: 'http://peer', secret: 's', timeoutMs: 1000 });
        await expect(call('/v1/x', 'req-1')).rejects.toThrow(/fetch failed/u);
    });
});
