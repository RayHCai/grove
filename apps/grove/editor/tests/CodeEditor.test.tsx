import { StrictMode, act } from 'react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { ThemeProvider, useTheme } from '@grove/ui';
import { CodeEditor } from '../src/editor/CodeEditor';
import { mountEditor } from '../src/editor/monaco';
import { render, until } from './helpers';

interface MockHandle {
    dispose: Mock;
    setTheme: Mock;
}

const mounted = vi.mocked(mountEditor);

const file = {
    path: 'src/main.ts',
    name: 'main.ts',
    language: 'typescript',
    value: 'let x = 1;',
};

function GoDark(): React.JSX.Element {
    const { setPreference } = useTheme();
    return <button type="button" data-dark onClick={() => setPreference('dark')} />;
}

function editor(props: { className?: string | undefined } = {}): ReactNode {
    return (
        <StrictMode>
            <ThemeProvider>
                <CodeEditor file={file} {...props} />
                <GoDark />
            </ThemeProvider>
        </StrictMode>
    );
}

async function untilMounted(): Promise<MockHandle> {
    await until(() => mounted.mock.results.length > 0);
    const first = mounted.mock.results[0];
    if (first === undefined) throw new Error('the editor never mounted');
    return first.value as MockHandle;
}

afterEach(() => {
    mounted.mockClear();
});

describe('CodeEditor', () => {
    it('mounts monaco exactly once under StrictMode, with the value, theme and label', async () => {
        const { host } = render(editor());
        await untilMounted();
        expect(mounted).toHaveBeenCalledOnce();
        expect(mounted.mock.calls[0]?.[0]).toBe(host.querySelector('.editor-host'));
        expect(mounted.mock.calls[0]?.[1]).toEqual({ file, theme: 'light' });
    });

    it('shows a live placeholder and a busy region until the editor is in', async () => {
        const { host } = render(editor());
        const region = host.querySelector('[role="region"]');
        expect(region?.getAttribute('aria-label')).toBe('Code');
        expect(region?.getAttribute('aria-busy')).toBe('true');
        const status = host.querySelector('[role="status"]');
        expect(status?.textContent).toBe('Loading editor…');
        expect(status?.className).toBe('editor-status');

        await untilMounted();
        expect(region?.getAttribute('aria-busy')).toBe('false');
        expect(host.querySelector('[role="status"]')).toBeNull();
    });

    it('is a plain body described by the hidden key hint, and keeps the class it is given', async () => {
        const { host } = render(editor({ className: 'cell' }));
        await untilMounted();
        const region = host.querySelector('[role="region"]');
        expect(region?.tagName).toBe('DIV');
        expect(region?.className).toBe('editor-body cell');
        expect(host.querySelector('.pg-panel')).toBeNull();
        const hint = host.querySelector('.pg-visually-hidden');
        expect(hint?.tagName).toBe('P');
        expect(hint?.id).toBe(region?.getAttribute('aria-describedby'));
        expect(hint?.textContent).toBe(
            'Press Ctrl+M (Ctrl+Shift+M on a Mac), then Tab, to leave the code editor.',
        );
        expect(host.querySelector('.editor-host')?.parentElement).toBe(region);
    });

    it('retints the editor when the theme flips', async () => {
        const { host } = render(editor());
        const handle = await untilMounted();
        expect(handle.setTheme).toHaveBeenLastCalledWith('light');

        await act(async () => {
            host.querySelector<HTMLButtonElement>('[data-dark]')?.click();
        });
        expect(document.documentElement.dataset.theme).toBe('dark');
        expect(handle.setTheme).toHaveBeenLastCalledWith('dark');
    });

    it('disposes the editor on unmount', async () => {
        const { root } = render(editor());
        const handle = await untilMounted();
        expect(handle.dispose).not.toHaveBeenCalled();

        await act(async () => {
            root.unmount();
        });
        expect(handle.dispose).toHaveBeenCalledOnce();
    });
});
