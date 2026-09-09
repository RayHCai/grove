import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { App } from '../src/App';

beforeAll(() => {
    // React refuses to run `act` without it, and says so at the first render rather than at setup.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('the app shell', () => {
    it('mounts into a host element', async () => {
        const host = document.createElement('div');
        document.body.append(host);

        await act(async () => {
            createRoot(host).render(<App />);
        });

        expect(host.querySelector('main')?.textContent).toBe('Grove');
    });
});
