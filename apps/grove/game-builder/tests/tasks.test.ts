import { describe, expect, it } from 'vitest';
import type { TaskId } from '@grove/api-contract';
import type { ApiCall } from '../src/store.js';
import { httpTasks } from '../src/tasks.js';

const TASK = '2b6d4f8a-1c3e-4d5f-9a7b-6c8d0e2f4a1b' as TaskId;

function answering(status: number, headers: Record<string, string> = {}): ApiCall {
    return async () =>
        new Response(JSON.stringify({ code: 'conflict', message: 'no' }), { status, headers });
}

describe('a claim the API refuses', () => {
    it('is acknowledged when the task is settled already', async () => {
        const tasks = httpTasks(answering(409), 'box-1');
        expect(await tasks.advance(TASK, { status: 'IN_PROGRESS' }, TASK)).toEqual({
            outcome: 'refused',
        });
    });

    it('is retried when another worker holds a live lease on it', async () => {
        const tasks = httpTasks(answering(409, { 'retry-after': '30' }), 'box-1');
        expect(await tasks.advance(TASK, { status: 'IN_PROGRESS' }, TASK)).toEqual({
            outcome: 'unavailable',
        });
    });
});

describe('every write', () => {
    it('names this box as the holder of the claim', async () => {
        const seen: (string | undefined)[] = [];
        const call: ApiCall = async (_path, _id, init) => {
            seen.push(new Headers(init?.headers).get('x-grove-worker') ?? undefined);
            return new Response(null, { status: 404 });
        };
        await httpTasks(call, 'box-1').advance(TASK, { status: 'FAILED' }, TASK);
        expect(seen).toEqual(['box-1']);
    });
});
