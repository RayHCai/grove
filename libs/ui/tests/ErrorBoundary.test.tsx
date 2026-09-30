import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../src/components/ErrorBoundary.js';
import { mount } from '../src/testing.js';

function Throws(): React.JSX.Element {
    throw new Error('a render that broke');
}

describe('ErrorBoundary', () => {
    beforeEach(() => {
        // React reports a caught render error on the console as well; the boundary is the subject.
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders what it wraps while nothing throws', async () => {
        const host = await mount(
            <ErrorBoundary>
                <p>all well</p>
            </ErrorBoundary>,
        );
        expect(host.textContent).toBe('all well');
    });

    it('swaps a tree that threw for a way back, and tells its host once', async () => {
        const onError = vi.fn();
        const reload = vi.fn();
        const host = await mount(
            <ErrorBoundary onError={onError} reload={reload}>
                <Throws />
            </ErrorBoundary>,
        );

        expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/broke/u);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0]?.[0]).toMatchObject({ message: 'a render that broke' });

        await act(async () => {
            host.querySelector('button')?.click();
        });
        expect(reload).toHaveBeenCalledTimes(1);
    });
});
