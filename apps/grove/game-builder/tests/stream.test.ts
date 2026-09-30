// The loop around a build: what it does when one message throws, when Redis fails, when the
// group is deleted under it, and what the health route learns when the loop is gone.

import { describe, expect, it, vi } from 'vitest';
import { startConsumer, type BuildStream } from '../src/consumer.js';
import { readEnv } from '../src/env.js';
import { CLAIMED, TASK_ID, quiet, silent, writing } from './doubles.js';

const env = readEnv({ FLEET_SECRET: 'c'.repeat(32), API_URL: 'http://api.grove.internal:4000' });

type Step = () => Promise<unknown>;

/**
 * A stream that answers each read from a script and then idles, so a test can say what the next
 * few round trips return and let the loop run into them.
 */
function scripted(reads: Step[], extra: { xgroup?: Step } = {}) {
    const acked: string[] = [];
    let groups = 0;
    const stream = {
        xgroup: vi.fn(async () => {
            groups += 1;
            return extra.xgroup === undefined ? 'OK' : extra.xgroup();
        }),
        xautoclaim: vi.fn(async () => ['0-0', []]),
        xreadgroup: vi.fn(async () => {
            const next = reads.shift();
            if (next !== undefined) return next();
            await new Promise((resolve) => setTimeout(resolve, 5));
            return null;
        }),
        xack: vi.fn(async (_stream: string, _group: string, id: string) => {
            acked.push(id);
            return 1;
        }),
    };
    return { stream: stream as unknown as BuildStream, acked, groups: () => groups };
}

function message(id: string, taskId: string = TASK_ID): Step {
    return async () => [['grove:tasks:build', [[id, ['taskId', taskId]]]]];
}

async function until(condition: () => boolean): Promise<void> {
    for (let spins = 0; spins < 400 && !condition(); spins++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(condition()).toBe(true);
}

describe('the build consumer', () => {
    it('leaves a message that threw unacknowledged, and goes on to the next', async () => {
        let calls = 0;
        const tasks = {
            advance: async () => {
                calls += 1;
                if (calls === 1) throw new Error('boom');
                return { outcome: 'refused' as const };
            },
        };
        const { stream, acked } = scripted([message('1-0'), message('2-0')]);
        const consumer = startConsumer(
            stream,
            { tasks, store: silent(), env, log: quiet() },
            env,
            'box',
        );

        await until(() => acked.length > 0);
        await consumer.stop();
        // The first is left for the reclaim; the second, already settled elsewhere, is acknowledged.
        expect(acked).toEqual(['2-0']);
    });

    it('acknowledges a message that names no task rather than reclaiming it forever', async () => {
        const { stream, acked } = scripted([message('1-0', 'not-a-uuid')]);
        const consumer = startConsumer(
            stream,
            { tasks: writing(), store: silent(), env, log: quiet() },
            env,
            'box',
        );
        await until(() => acked.length > 0);
        await consumer.stop();
        expect(acked).toEqual(['1-0']);
    });

    it('logs a Redis failure and keeps reading', async () => {
        const log = quiet();
        const { stream, acked } = scripted([
            async () => {
                throw new Error('connection lost');
            },
            message('3-0'),
        ]);
        const consumer = startConsumer(
            stream,
            { tasks: writing({ outcome: 'refused' }), store: silent(), env, log },
            env,
            'box',
        );

        await until(() => acked.length > 0);
        expect(consumer.running()).toBe(true);
        await consumer.stop();
        expect(log.lines.some((line) => line.level === 'error')).toBe(true);
        expect(acked).toEqual(['3-0']);
    });

    it('recreates the group when Redis says it is gone', async () => {
        const { stream, groups } = scripted([
            async () => {
                throw new Error('NOGROUP No such key or consumer group');
            },
        ]);
        const consumer = startConsumer(
            stream,
            { tasks: writing(), store: silent(), env, log: quiet() },
            env,
            'box',
        );
        await until(() => groups() >= 2);
        await consumer.stop();
    });

    it('says it is not running once the loop has ended on its own', async () => {
        const broken = quiet();
        // A log that throws once is the one thing the loop's own failure path cannot survive.
        const report = broken.error;
        let thrown = false;
        broken.error = ((...args: Parameters<typeof report>) => {
            if (!thrown) {
                thrown = true;
                throw new Error('the log is gone');
            }
            report(...args);
        }) as typeof report;
        const { stream } = scripted([
            async () => {
                throw new Error('connection lost');
            },
        ]);
        const consumer = startConsumer(
            stream,
            { tasks: writing(), store: silent(), env, log: broken },
            env,
            'box',
        );
        await until(() => !consumer.running());
        await consumer.stop();
    });

    it('fails a task whose attempts are spent before compiling it again', async () => {
        const spent = { ...CLAIMED, attempts: env.BUILD_ATTEMPTS + 1 };
        const tasks = writing({ outcome: 'settled', task: spent });
        const { stream, acked } = scripted([message('4-0')]);
        const consumer = startConsumer(
            stream,
            { tasks, store: silent(), env, log: quiet() },
            env,
            'box',
        );

        await until(() => acked.length > 0);
        await consumer.stop();
        expect(tasks.wrote[1]?.status).toBe('FAILED');
        expect(tasks.wrote[1]?.detail?.message).toMatch(/gave up after 3 attempts/u);
    });
});
