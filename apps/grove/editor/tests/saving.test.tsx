// Saving from the workbench: what is sent, what is left alone, what saves without being asked,
// and what a refusal puts on screen.

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { ThemeProvider } from '@grove/ui';
import { ApiError } from '../src/api/client';
import { mountEditor } from '../src/editor/monaco';
import { EditorShell } from '../src/shell/EditorShell';
import { SAVE_DEBOUNCE_MS } from '../src/workspace/autosave';
import { draftFromText } from '../src/workspace/files';
import { openGame } from '../src/workspace/session';
import { PROJECT_PATH } from '../src/project/manifest';
import { fakeApi, opened, stored, TEMPLATE_PATH } from './doubles';
import type { FakeApi } from './doubles';
import { mount, until, untilSettled } from './helpers';

const mounted = vi.mocked(mountEditor);

interface Workbench {
    onChange: Mock;
    syncFiles: Mock;
}

async function shell(api: FakeApi = fakeApi(), lapsed: () => void = vi.fn()): Promise<HTMLElement> {
    const host = await mount(
        <ThemeProvider>
            <EditorShell api={api} opened={opened()} onSessionLapsed={lapsed} />
        </ThemeProvider>,
    );
    await untilSettled(host);
    return host;
}

/** The shell opened on a game the service is already holding, the way a second visit opens. */
async function reopened(api: FakeApi): Promise<HTMLElement> {
    const open = await openGame(api, vi.fn());
    const host = await mount(
        <ThemeProvider>
            <EditorShell api={api} opened={open} onSessionLapsed={vi.fn()} />
        </ThemeProvider>,
    );
    await untilSettled(host);
    return host;
}

function workbench(): Workbench {
    const last = mounted.mock.results.at(-1);
    if (last === undefined) throw new Error('the editor never mounted');
    return last.value as Workbench;
}

/** Types into the file the workbench has open, the way Monaco reports a keystroke. */
async function type(path: string, text: string): Promise<void> {
    const listener = workbench().onChange.mock.calls.at(-1)?.[0] as (
        path: string,
        text: string,
    ) => void;
    await act(async () => {
        listener(path, text);
    });
}

function press(host: HTMLElement, label: string): Promise<void> {
    return act(async () => {
        [...host.querySelectorAll('button')].find((each) => each.textContent === label)?.click();
    });
}

function state(host: HTMLElement): string | undefined {
    return host.querySelector('.topbar__state')?.textContent ?? undefined;
}

function paths(host: HTMLElement): (string | null)[] {
    return [...host.querySelectorAll('.tree__name')].map((name) => name.textContent);
}

describe('saving', () => {
    it('offers nothing to save until something has changed', async () => {
        const api = fakeApi();
        await stored(api, [draftFromText('src/main.ts', 'const a = 1;')]);
        const host = await reopened(api);

        const save = (): HTMLButtonElement | null => host.querySelector('.topbar__save');
        expect(save()?.getAttribute('aria-disabled')).toBe('true');
        expect(state(host)).toBe('Up to date');

        await type('src/main.ts', 'const a = 2;');
        expect(save()?.hasAttribute('aria-disabled')).toBe(false);
        expect(state(host)).toBe('Unsaved changes');
    });

    it('sends the whole template the first time, and says which revision it produced', async () => {
        const api = fakeApi();
        const host = await shell(api);

        await press(host, 'Save');
        await until(() => state(host) !== 'Saving…');

        expect(state(host)).toBe('Saved as revision 1');
        expect(api.saves).toHaveLength(1);
        expect(api.saves[0]?.sources.map((source) => source.path)).toEqual([
            TEMPLATE_PATH,
            PROJECT_PATH,
        ]);
    });

    it('sends only what changed the second time round', async () => {
        const api = fakeApi();
        const host = await shell(api);
        await press(host, 'Save');
        await until(() => state(host) === 'Saved as revision 1');

        await type(TEMPLATE_PATH, 'const a = 3;');
        await press(host, 'Save');
        await until(() => state(host) === 'Saved as revision 2');

        expect(api.saves[1]?.sources.map((source) => source.path)).toEqual([TEMPLATE_PATH]);
        expect(api.saves[1]?.deletes).toEqual([]);
    });

    it('carries a new file, and names a removed one as deleted', async () => {
        const api = fakeApi();
        const host = await shell(api);

        await act(async () => {
            [...host.querySelectorAll('button')]
                .find((each) => each.textContent === 'New file')
                ?.click();
        });
        const field = host.querySelector<HTMLInputElement>('.explorer-panel__new input');
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
                field,
                'src/enemy.ts',
            );
            field?.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => {
            host.querySelector('.explorer-panel__new')?.dispatchEvent(
                new Event('submit', { bubbles: true, cancelable: true }),
            );
        });
        expect(paths(host)).toContain('enemy.ts');

        await press(host, 'Save');
        await until(() => state(host) === 'Saved as revision 1');
        expect(api.saves[0]?.sources.map((source) => source.path)).toContain('src/enemy.ts');

        await press(host, 'Delete');
        await press(host, 'Save');
        await until(() => state(host) === 'Saved as revision 2');
        expect(api.saves[1]?.deletes).toEqual(['src/enemy.ts']);
    });

    it('reloads from the service rather than overwriting what somebody else saved', async () => {
        const api = fakeApi();
        await stored(api, [draftFromText('src/main.ts', 'const a = 1;')], 1);
        const host = await reopened(api);

        await type('src/main.ts', 'const a = 2;');
        // Somebody else saved while this editor was open, so revision 1 is no longer the base.
        api.workspaceState = { ...api.workspaceState, revision: 7 };

        await press(host, 'Save');
        await until(() => state(host)?.includes('reloaded') === true);
        expect(state(host)).toContain('revision 7');
        expect(host.querySelector('.topbar__state')?.className).toContain('--failed');
    });
});

describe('a session that lapses with the workbench open', () => {
    it('says so and leaves the work standing rather than navigating away', async () => {
        const api = fakeApi();
        const lapsed = vi.fn();
        const host = await shell(api, lapsed);
        vi.spyOn(api, 'save').mockRejectedValue(new ApiError(401, 'unauthorized', 'sign in first'));

        await press(host, 'Save');
        await until(() => state(host) !== 'Saving…');

        expect(lapsed).toHaveBeenCalledTimes(1);
        expect(state(host)).toBe('your Grove session ended; sign in again, then save');
        // The point of the second tab: what was typed is still here to save once they are back.
        expect(host.querySelector('main.workspace')).not.toBeNull();
    });

    it('reads a refusal no body named by its status, which a proxy is what sends', async () => {
        const api = fakeApi();
        const lapsed = vi.fn();
        const host = await shell(api, lapsed);
        // What `refusal()` makes of a 401 carrying no ErrorBody at all.
        vi.spyOn(api, 'save').mockRejectedValue(
            new ApiError(401, 'internal', 'the API answered 401'),
        );

        await press(host, 'Save');
        await until(() => state(host) !== 'Saving…');
        expect(lapsed).toHaveBeenCalledTimes(1);
    });

    it('tells them once, not once per autosave', async () => {
        const api = fakeApi();
        const lapsed = vi.fn();
        const host = await shell(api, lapsed);
        vi.spyOn(api, 'save').mockRejectedValue(new ApiError(401, 'unauthorized', 'sign in first'));

        await press(host, 'Save');
        await until(() => state(host) !== 'Saving…');
        await press(host, 'Save');
        await until(() => state(host) !== 'Saving…');

        expect(lapsed).toHaveBeenCalledTimes(1);
    });

    it('tells them again when a later session lapses after one that saved', async () => {
        const api = fakeApi();
        const lapsed = vi.fn();
        const host = await shell(api, lapsed);
        const refusing = vi
            .spyOn(api, 'save')
            .mockRejectedValue(new ApiError(401, 'unauthorized', 'sign in first'));

        await press(host, 'Save');
        await until(() => state(host) !== 'Saving…');

        // They signed in on the other tab and saved, which spends the alert.
        refusing.mockRestore();
        await press(host, 'Save');
        await until(() => state(host)?.startsWith('Saved') === true);

        vi.spyOn(api, 'save').mockRejectedValue(new ApiError(401, 'unauthorized', 'sign in first'));
        await type(TEMPLATE_PATH, 'const a = 3;');
        await press(host, 'Save');
        await until(() => state(host) !== 'Saving…');

        expect(lapsed).toHaveBeenCalledTimes(2);
    });
});

describe('saving without being asked', () => {
    it('saves on its own once the typing stops', async () => {
        vi.useFakeTimers();
        try {
            const api = fakeApi();
            await stored(api, [draftFromText('src/main.ts', 'const a = 1;')]);
            await reopened(api);

            await type('src/main.ts', 'const a = 2;');
            expect(api.saves).toHaveLength(0);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
            });
            expect(api.saves).toHaveLength(1);
            expect(api.saves[0]?.sources.map((source) => source.path)).toEqual(['src/main.ts']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('flushes what is unsaved when the tab goes away', async () => {
        const api = fakeApi();
        await stored(api, [draftFromText('src/main.ts', 'const a = 1;')]);
        await reopened(api);
        const flushed = vi.spyOn(api, 'saveOnExit');

        await type('src/main.ts', 'const a = 2;');
        await act(async () => {
            Object.defineProperty(document, 'visibilityState', {
                value: 'hidden',
                configurable: true,
            });
            document.dispatchEvent(new Event('visibilitychange'));
        });

        expect(flushed).toHaveBeenCalledOnce();
        expect(flushed.mock.calls[0]?.[1].sources.map((source) => source.path)).toEqual([
            'src/main.ts',
        ]);
    });

    it('cancels the unload of a tab holding work nothing has saved', async () => {
        const api = fakeApi();
        await stored(api, [draftFromText('src/main.ts', 'const a = 1;')]);
        await reopened(api);

        const clean = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(clean);
        expect(clean.defaultPrevented).toBe(false);

        await type('src/main.ts', 'const a = 2;');
        const dirty = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(dirty);
        expect(dirty.defaultPrevented).toBe(true);
    });
});
