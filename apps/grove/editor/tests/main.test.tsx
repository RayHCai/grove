import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
    // React refuses to run `act` without it, and says so at the first render rather than at setup.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
    document.body.innerHTML = '';
    // The entry point runs on import, so each case needs it evaluated again.
    vi.resetModules();
});

describe('the entry point', () => {
    it('mounts the shell into #root', async () => {
        const host = document.createElement('div');
        host.id = 'root';
        document.body.append(host);

        await act(async () => {
            await import('../src/main');
        });

        expect(host.querySelector('main')?.textContent).toBe('Grove — editor');
    });

    it('refuses to mount when the document carries no #root', async () => {
        await expect(import('../src/main')).rejects.toThrow('#root is missing from index.html');
    });
});
