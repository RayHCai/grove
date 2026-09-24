// A queued task: what each kind is allowed to name, what a worker may write back, and which
// stream carries it.

import { describe, expect, it } from 'vitest';
import {
    Task,
    TaskStatusUpdate,
    databaseOf,
    isTerminal,
    streamOf,
    type TaskStatus,
} from '../src/tasks.js';

const TASK_ID = '5b2f7cbe-6d1a-4f7d-9d4a-1b8d2c3e4f50';
const GAME_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const BUNDLE_HASH = 'b7c2'.repeat(16);
const SOURCE_HASH = 'a3f1'.repeat(16);

const queued = {
    taskId: TASK_ID,
    gameId: GAME_ID,
    kind: 'BUILD',
    status: 'NOT_STARTED',
    manifestRevision: 4,
    attempts: 0,
    createdAt: '2026-09-18T12:00:00.000Z',
    updatedAt: '2026-09-18T12:00:00.000Z',
};

describe('a task', () => {
    it('round-trips one nothing has claimed, with neither a start nor a finish', () => {
        const parsed = Task.parse(queued);
        expect(parsed).toEqual(queued);
        expect(parsed.startedAt).toBeUndefined();
        expect(parsed.detail).toBeUndefined();
    });

    it('is pinned to a manifest, because a build is of a snapshot and not of a draft', () => {
        expect(Task.safeParse({ ...queued, manifestRevision: 0 }).success).toBe(false);
        expect(Task.safeParse({ ...queued, manifestRevision: undefined }).success).toBe(false);
    });

    it('names an asset exactly when it is an asset upload', () => {
        const upload = { ...queued, kind: 'ASSET_UPLOAD', assetPath: 'art/tile.png' };
        expect(Task.safeParse(upload).success).toBe(true);
        expect(Task.safeParse({ ...queued, assetPath: 'art/tile.png' }).success).toBe(false);
        expect(Task.safeParse({ ...queued, kind: 'ASSET_UPLOAD' }).success).toBe(false);
    });

    it('carries the manifest a build wrote, and the warnings it still had', () => {
        const settled = {
            ...queued,
            status: 'SUCCESSFUL',
            startedAt: '2026-09-18T12:00:01.000Z',
            finishedAt: '2026-09-18T12:00:44.000Z',
            detail: {
                build: {
                    gameId: GAME_ID,
                    revision: 4,
                    projectId: 'leaf-harvest',
                    projectHash: SOURCE_HASH,
                    bundles: {
                        server: {
                            side: 'server',
                            hash: BUNDLE_HASH,
                            url: `https://cdn.grove.example/b/${BUNDLE_HASH}`,
                            byteLength: 81_920,
                        },
                        client: {
                            side: 'client',
                            hash: SOURCE_HASH,
                            url: `https://cdn.grove.example/b/${SOURCE_HASH}`,
                            byteLength: 65_536,
                        },
                        simConfig: {
                            hash: BUNDLE_HASH,
                            url: `https://cdn.grove.example/b/${BUNDLE_HASH}.json`,
                            byteLength: 142,
                        },
                        syncedHash: SOURCE_HASH,
                    },
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
            },
        };
        expect(Task.parse(settled)).toEqual(settled);
    });

    it('rejects a diagnostic severity the editor has no gutter for', () => {
        const noisy = {
            ...queued,
            detail: {
                diagnostics: [
                    { severity: 'info', file: 'src/enemy.ts', line: 1, column: 1, message: 'hi' },
                ],
            },
        };
        expect(Task.safeParse(noisy).success).toBe(false);
    });

    it('rejects a status nothing produces', () => {
        expect(Task.safeParse({ ...queued, status: 'queued' }).success).toBe(false);
    });
});

describe('a status update', () => {
    it('takes the states a worker moves a task into', () => {
        for (const status of ['IN_PROGRESS', 'SUCCESSFUL', 'FAILED', 'CANCELLED']) {
            expect(TaskStatusUpdate.safeParse({ status }).success).toBe(true);
        }
    });

    it('refuses to put a task back to the state the sweeper re-pushes from', () => {
        expect(TaskStatusUpdate.safeParse({ status: 'NOT_STARTED' }).success).toBe(false);
    });
});

describe('a settled task', () => {
    it('is one nothing moves out of', () => {
        const terminal: TaskStatus[] = ['SUCCESSFUL', 'FAILED', 'CANCELLED'];
        for (const status of terminal) expect(isTerminal(status)).toBe(true);
        for (const status of ['NOT_STARTED', 'IN_PROGRESS'] as TaskStatus[]) {
            expect(isTerminal(status)).toBe(false);
        }
    });
});

describe('the streams', () => {
    it('are one per kind, so neither service skips what the other queued', () => {
        expect(streamOf('BUILD')).not.toBe(streamOf('ASSET_UPLOAD'));
    });

    it('sit in a database of their own, so an operator reaches one kind at a time', () => {
        expect(databaseOf('BUILD')).not.toBe(databaseOf('ASSET_UPLOAD'));
    });

    it('put asset uploads in zero, where a URL that names no database already lands', () => {
        expect(databaseOf('ASSET_UPLOAD')).toBe(0);
    });
});
