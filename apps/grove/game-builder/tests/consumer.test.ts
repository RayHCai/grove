// What a build box does with one claimed task: what it reads, what it writes back, and which
// failures leave the message for another box to take.

import { describe, expect, it } from 'vitest';
import { GameId, Task, TaskId, VersionId } from '@grove/api-contract';
import type { Manifest, TaskStatusUpdate } from '@grove/api-contract';
import { runBuild } from '../src/consumer.js';
import type { Builder } from '../src/consumer.js';
import type { Manifests } from '../src/manifests.js';
import type { Tasks, TaskWritten } from '../src/tasks.js';

const TASK_ID = TaskId.parse('8c2e4a60-5d17-4b93-8f0a-1e6d2c4b7a35');
const GAME_ID = GameId.parse('9f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f');

const CLAIMED: Task = Task.parse({
    taskId: TASK_ID,
    gameId: GAME_ID,
    kind: 'BUILD',
    status: 'IN_PROGRESS',
    manifestRevision: 7,
    attempts: 1,
    createdAt: '2026-09-18T09:00:00.000Z',
    updatedAt: '2026-09-18T09:00:01.000Z',
    startedAt: '2026-09-18T09:00:01.000Z',
});

const MANIFEST: Manifest = {
    gameId: GAME_ID,
    revision: 7,
    files: [
        {
            path: 'main.ts',
            kind: 'source',
            versionId: VersionId.parse('v1'),
            byteLength: 30,
            contentType: 'text/typescript',
        },
        {
            path: 'art/tile.png',
            kind: 'asset',
            versionId: VersionId.parse('v2'),
            byteLength: 512,
            contentType: 'image/png',
        },
    ],
};

/** A log that keeps what it was told, so a stub that only reports can still be asserted on. */
function quiet(): Builder['log'] & { lines: { level: string; details: object }[] } {
    const lines: { level: string; details: object }[] = [];
    const at =
        (level: string) =>
        (details: object = {}) => {
            lines.push({ level, details });
        };
    return { lines, info: at('info'), warn: at('warn'), error: at('error') } as never;
}

/** A task seam that records every update and answers each one from `answers`, in order. */
function writing(...answers: TaskWritten[]): Tasks & { wrote: TaskStatusUpdate[] } {
    const wrote: TaskStatusUpdate[] = [];
    let at = 0;
    return {
        wrote,
        advance: async (_task, update) => {
            wrote.push(update);
            const answer = answers[at] ?? { outcome: 'settled', task: CLAIMED };
            at += 1;
            return answer;
        },
    };
}

const holding: Manifests = { read: async () => MANIFEST };
const empty: Manifests = { read: async () => undefined };

describe('a claimed build', () => {
    it('claims the task, reads its manifest, and settles it as successful', async () => {
        const tasks = writing({ outcome: 'settled', task: CLAIMED });
        const log = quiet();

        expect(await runBuild(TASK_ID, { tasks, manifests: holding, log })).toBe('settled');
        expect(tasks.wrote[0]).toEqual({ status: 'IN_PROGRESS' });
        expect(tasks.wrote[1]).toEqual({
            status: 'SUCCESSFUL',
            detail: { fileCount: 2, byteLength: 542 },
        });
    });

    it('reports what it read, which is what stands in for build output for now', async () => {
        const log = quiet();
        await runBuild(TASK_ID, { tasks: writing(), manifests: holding, log });

        expect(log.lines.at(-1)?.details).toMatchObject({
            fileCount: 2,
            byteLength: 542,
            paths: ['main.ts', 'art/tile.png'],
        });
    });

    it('is acknowledged when it was already settled, or it comes back forever', async () => {
        const tasks = writing({ outcome: 'refused' });
        expect(await runBuild(TASK_ID, { tasks, manifests: holding, log: quiet() })).toBe(
            'settled',
        );
        // Nothing was compiled and nothing was written: the claim itself was refused.
        expect(tasks.wrote).toHaveLength(1);
    });

    it('is left for another box when the claim could not be written down', async () => {
        const tasks = writing({ outcome: 'unavailable' });
        expect(await runBuild(TASK_ID, { tasks, manifests: holding, log: quiet() })).toBe('retry');
    });

    it('is left for another box when the outcome could not be written down', async () => {
        const tasks = writing({ outcome: 'settled', task: CLAIMED }, { outcome: 'unavailable' });
        expect(await runBuild(TASK_ID, { tasks, manifests: holding, log: quiet() })).toBe('retry');
    });

    it('fails against the box rather than against the source when the manifest is gone', async () => {
        const tasks = writing({ outcome: 'settled', task: CLAIMED });
        expect(await runBuild(TASK_ID, { tasks, manifests: empty, log: quiet() })).toBe('settled');
        expect(tasks.wrote[1]).toMatchObject({ status: 'FAILED' });
        // No diagnostic, because nothing in their source can make a manifest unreadable.
        expect(tasks.wrote[1]?.detail?.diagnostics).toBeUndefined();
    });
});
