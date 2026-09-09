// A build job: the states a creator's editor is allowed to render, and what a success carries.

import { describe, expect, it } from 'vitest';
import { BuildJob, BuildRequest } from '../src/build.js';

const JOB_ID = '5b2f7cbe-6d1a-4f7d-9d4a-1b8d2c3e4f50';
const GAME_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const SOURCE_HASH = 'a3f1'.repeat(16);
const SERVER_HASH = 'b7c2'.repeat(16);
const CLIENT_HASH = 'c8d3'.repeat(16);

const queued = {
    jobId: JOB_ID,
    gameId: GAME_ID,
    state: 'queued',
    queuedAt: '2026-09-05T12:00:00.000Z',
    diagnostics: [],
};

describe('a build job', () => {
    it('round-trips a queued job with neither a start nor a finish', () => {
        const parsed = BuildJob.parse(queued);
        expect(parsed).toEqual(queued);
        expect(parsed.startedAt).toBeUndefined();
        expect(parsed.bundles).toBeUndefined();
    });

    it('rejects a state nothing produces', () => {
        expect(BuildJob.safeParse({ ...queued, state: 'cancelled' }).success).toBe(false);
        expect(BuildJob.safeParse({ ...queued, state: 'SUCCEEDED' }).success).toBe(false);
    });

    it('carries the bundle set a success registered', () => {
        const finished = {
            ...queued,
            state: 'succeeded',
            startedAt: '2026-09-05T12:00:01.000Z',
            finishedAt: '2026-09-05T12:00:44.000Z',
            bundles: {
                server: {
                    side: 'server',
                    hash: SERVER_HASH,
                    url: 'https://cdn.grove.example/b/' + SERVER_HASH,
                    byteLength: 81_920,
                },
                client: {
                    side: 'client',
                    hash: CLIENT_HASH,
                    url: 'https://cdn.grove.example/b/' + CLIENT_HASH,
                    byteLength: 65_536,
                },
                syncedHash: SOURCE_HASH,
            },
            diagnostics: [
                {
                    severity: 'warning',
                    file: 'src/enemy.ts',
                    line: 12,
                    column: 5,
                    message: 'unused import',
                },
            ],
        };
        expect(BuildJob.parse(finished)).toEqual(finished);
    });

    it('rejects a diagnostic severity the editor has no gutter for', () => {
        const noisy = {
            ...queued,
            diagnostics: [
                { severity: 'info', file: 'src/enemy.ts', line: 1, column: 1, message: 'hello' },
            ],
        };
        expect(BuildJob.safeParse(noisy).success).toBe(false);
    });
});

describe('a build request', () => {
    it('names the source rather than carrying it', () => {
        expect(BuildRequest.parse({ gameId: GAME_ID, sourceHash: SOURCE_HASH })).toEqual({
            gameId: GAME_ID,
            sourceHash: SOURCE_HASH,
        });
        expect(BuildRequest.safeParse({ gameId: GAME_ID, sourceHash: 'HEAD' }).success).toBe(false);
    });
});
