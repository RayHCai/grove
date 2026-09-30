// A build that was not told to show what is drawn but not wired to anything yet.

import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@grove/ui';
import { EditorShell } from '../src/shell/EditorShell';
import { fakeApi, opened } from './doubles';
import { mount, untilSettled } from './helpers';

vi.mock('../src/unfinished', () => ({ UNFINISHED: false }));

describe('a build without the unfinished parts', () => {
    it('offers no Grove AI, which answers nothing yet', async () => {
        const host = await mount(
            <ThemeProvider>
                <EditorShell api={fakeApi()} opened={opened()} onSessionLapsed={vi.fn()} />
            </ThemeProvider>,
        );
        await untilSettled(host);

        expect(host.querySelector('button[aria-label="Explorer"]')).not.toBeNull();
        expect(host.querySelector('button[aria-label="Grove AI"]')).toBeNull();
        expect(host.querySelector('#grove-ai-panel')).toBeNull();
    });
});
