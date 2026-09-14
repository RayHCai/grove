// The entrypoint a deploy runs, and what it does on a box with no toolchain behind the queue.

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('booting a build box', () => {
    it('refuses to start rather than accept builds it has no compiler to run', async () => {
        vi.stubEnv('FLEET_SECRET', 'e'.repeat(32));

        await expect(import('../src/main.js')).rejects.toThrow(/no compiler attached/);
    });
});
