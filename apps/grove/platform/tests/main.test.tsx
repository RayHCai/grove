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
    // Cold-imports the whole app, which outruns the 5 s default when the suites run in parallel.
    it('mounts the shell into #root', async () => {
        const host = document.createElement('div');
        host.id = 'root';
        document.body.append(host);

        await act(async () => {
            await import('../src/main');
        });

        // The real client is in play here, so what is on screen is the first load rather than a
        // page; that it mounted at all is the whole of what this pins.
        expect(host.querySelector('main')).not.toBeNull();
    }, 30_000);

    it('refuses to mount when the document carries no #root', async () => {
        await expect(import('../src/main')).rejects.toThrow('#root is missing from index.html');
    });
});
