// What the root error boundary sends before the workbench holding the typing is gone.

import { useState } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '@grove/ui';
import { CrashFlush, useCrashFlush } from '../src/workspace/autosave';
import { mount } from './helpers';

let breakNow: () => void = () => undefined;

/** Held outside any render, the way the app holds its own in state made once. */
const SLOT: { current: (() => void) | undefined } = { current: undefined };

function Workbench({ flush }: { flush: (() => void) | undefined }): React.JSX.Element {
    const [broken, setBroken] = useState(false);
    breakNow = () => setBroken(true);
    useCrashFlush(flush);
    if (broken) throw new Error('a render that broke');
    return <p>typing</p>;
}

describe('a workbench that throws', () => {
    beforeEach(() => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => {
        SLOT.current = undefined;
        vi.restoreAllMocks();
    });

    it('fires its exit save from the boundary, before the recovery view', async () => {
        const flush = vi.fn();
        const host = await mount(
            <ErrorBoundary onError={() => SLOT.current?.()}>
                <CrashFlush.Provider value={SLOT}>
                    <Workbench flush={flush} />
                </CrashFlush.Provider>
            </ErrorBoundary>,
        );

        await act(async () => {
            breakNow();
        });

        expect(flush).toHaveBeenCalledOnce();
        expect(host.querySelector('[role="alert"]')).not.toBeNull();
    });

    it('sends nothing when nothing was unsaved', async () => {
        await mount(
            <ErrorBoundary onError={() => SLOT.current?.()}>
                <CrashFlush.Provider value={SLOT}>
                    <Workbench flush={undefined} />
                </CrashFlush.Provider>
            </ErrorBoundary>,
        );

        await act(async () => {
            breakNow();
        });
        expect(SLOT.current).toBeUndefined();
    });
});
