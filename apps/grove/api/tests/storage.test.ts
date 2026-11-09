// What the bucket's own failures become: a key that is not there is an answer, and a bucket that
// did not answer is not, so no caller can turn an outage into a 404.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { StorageUnavailable, s3Storage, type Storage } from '../src/storage.js';
import { testEnv } from './fixtures.js';

/** S3 as it answers a key that is absent, and as it answers when it refuses the caller outright. */
function s3Error(code: string, status: number): { status: number; body: string } {
    return {
        status,
        body: `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
    };
}

const ANSWERS: Record<string, { status: number; body: string }> = {
    '/games/missing': s3Error('NoSuchKey', 404),
    '/games/denied': s3Error('AccessDenied', 403),
};

let server: Server;
let storage: Storage;
const logged: string[] = [];

beforeAll(async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'test');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test');
    server = createServer((request, response) => {
        const answer =
            ANSWERS[(request.url ?? '').split('?')[0] ?? ''] ?? s3Error('NoSuchKey', 404);
        response.writeHead(answer.status, { 'content-type': 'application/xml' });
        response.end(request.method === 'HEAD' ? undefined : answer.body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const log = {
        error: (_details: object, message: string) => logged.push(`error ${message}`),
        warn: (_details: object, message: string) => logged.push(`warn ${message}`),
    } as unknown as FastifyBaseLogger;
    storage = s3Storage(testEnv({ S3_ENDPOINT: `http://127.0.0.1:${port}` }), 'games', () => log);
});

afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the games bucket over S3', () => {
    it('answers nothing for a key that is not there', async () => {
        expect(await storage.get('missing')).toBeUndefined();
        expect(await storage.head('missing')).toBeUndefined();
    });

    it('throws for a read it refused, and says so in the log', async () => {
        logged.length = 0;
        await expect(storage.get('denied')).rejects.toBeInstanceOf(StorageUnavailable);
        await expect(storage.head('denied')).rejects.toBeInstanceOf(StorageUnavailable);
        expect(logged.filter((line) => line.startsWith('error'))).toHaveLength(2);
    });

    it('answers a refused write as unavailable rather than throwing', async () => {
        expect(await storage.put('denied', Buffer.from('x'), 'text/plain')).toEqual({
            outcome: 'unavailable',
        });
    });

    it('logs a delete marker it could not write rather than failing the save behind it', async () => {
        logged.length = 0;
        await expect(storage.remove('denied')).resolves.toBeUndefined();
        expect(logged).toContain('warn delete marker not written');
    });
});

describe('a presigned request', () => {
    it('signs an upload for its type and its length, and carries no checksum of an empty body', async () => {
        const signed = await storage.presignPut('uploads/g/art/tile.png', {
            contentType: 'image/png',
            byteLength: 2048,
            expiresInS: 900,
        });
        if (signed.outcome !== 'signed') throw new Error(signed.outcome);
        const query = new URL(signed.url).searchParams;
        expect(query.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
        expect([...query.keys()].filter((name) => name.toLowerCase().includes('checksum'))).toEqual(
            [],
        );
        // The browser sets the length from the body it sends; the type it is told to send.
        expect(signed.headers).toEqual({ 'content-type': 'image/png' });
    });

    it('pins a read to the version it names', async () => {
        const signed = await storage.presignGet('uploads/g/art/tile.png', 'v1' as never, 60);
        if (signed.outcome !== 'signed') throw new Error(signed.outcome);
        expect(new URL(signed.url).searchParams.get('versionId')).toBe('v1');
        expect(signed.headers).toEqual({});
    });
});
