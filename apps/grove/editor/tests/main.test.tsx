import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { until } from './helpers';

afterEach(() => {
    // The entry point runs on import, so each case needs it evaluated again.
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** The one answer a first load needs from a service nothing has signed into. */
function stubApi(): void {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 401 }));
}

describe('the entry point', () => {
    it('mounts the app into #root and dials the service for a session', async () => {
        stubApi();
        const host = document.createElement('div');
        host.id = 'root';
        document.body.append(host);

        await act(async () => {
            await import('../src/main');
        });
        // Nothing opens a session, so what the entry point lands on is the way to the platform.
        await until(() => host.querySelector('[role="status"]') !== null);

        expect(host.querySelector('[role="status"]')?.textContent).toBe(
            'Taking you to Grove to sign in…',
        );
        expect(host.querySelector('.pg-wordmark')?.textContent).toBe('Grove');
    });

    it('refuses to mount when the document carries no #root', async () => {
        stubApi();
        await expect(import('../src/main')).rejects.toThrow('#root is missing from index.html');
    });
});
