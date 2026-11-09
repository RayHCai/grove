// Saving from the workbench: what is sent, what is left alone, what saves without being asked,
// and what a refusal puts on screen.

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { ThemeProvider } from '@grove/ui';
import { ApiError } from '../src/api/client';
import { mountEditor } from '../src/editor/monaco';
import { EditorShell } from '../src/shell/EditorShell';
import { SAVE_CEILING_MS, SAVE_DEBOUNCE_MS } from '../src/workspace/autosave';
import { draftFromText } from '../src/workspace/files';
import { openGame } from '../src/workspace/session';
import { PROJECT_PATH } from '../src/project/manifest';
import { fakeApi, opened, stored, TEMPLATE_PATH } from './doubles';
import type { FakeApi } from './doubles';
import { mount, until, untilSettled } from '@grove/ui/testing';

const mounted = vi.mocked(mountEditor);

/** Shows or hides the tab the way the browser does, for a case that owns the restore below. */
async function visibility(shown: 'hidden' | 'visible'): Promise<void> {
    await act(async () => {
        Object.defineProperty(document, 'visibilityState', { value: shown, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
    });
}

afterEach(() => {
    // The own property shadows jsdom's getter; without it gone every later case is a hidden tab.
    Reflect.deleteProperty(document, 'visibilityState');
});

interface Workbench {
    onChange: Mock;
    syncFiles: Mock;
    resetFiles: Mock;
}

async function shell(api: FakeApi = fakeApi(), lapsed: () => void = vi.fn()): Promise<HTMLElement> {
    // As Boot does before the workbench mounts, which is what hands the client its token.
    await api.session();
    const host = await mount(
        <ThemeProvider>
            <EditorShell api={api} opened={opened()} onSessionLapsed={lapsed} />
        </ThemeProvider>,
    );
    await untilSettled(host);
    return host;
}

/** The shell opened on a game the service is already holding, the way a second visit opens. */
async function reopened(api: FakeApi, lapsed: () => void = vi.fn()): Promise<HTMLElement> {
    await api.session();
    const open = await openGame(api, vi.fn());
    const host = await mount(
        <ThemeProvider>
            <EditorShell api={api} opened={open} onSessionLapsed={lapsed} />
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

/** Removes a file the way the explorer does: from the row's own right-click menu. */
async function remove(host: HTMLElement, name: string): Promise<void> {
    const row = [...host.querySelectorAll('.tree__item')].find(
        (item) => item.querySelector('.tree__name')?.textContent === name,
    );
    await act(async () => {
        row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await act(async () => {
        host.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click();
    });
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

    it('sends the whole template the first time, and says the save landed', async () => {
        const api = fakeApi();
        const host = await shell(api);

        await press(host, 'Save');
        await until(() => state(host) !== 'Saving…');

        expect(state(host)).toBe('Saved');
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
        await until(() => api.saves.length === 1);

        await type(TEMPLATE_PATH, 'const a = 3;');
        await press(host, 'Save');
        await until(() => api.saves.length === 2);

        expect(api.saves[1]?.sources.map((source) => source.path)).toEqual([TEMPLATE_PATH]);
        expect(api.saves[1]?.deletes).toEqual([]);
    });

    it('carries a new file, and names a removed one as deleted', async () => {
        const api = fakeApi();
        const host = await shell(api);

        await act(async () => {
            host.querySelector<HTMLButtonElement>('button[aria-label="New file"]')?.click();
        });
        const field = host.querySelector<HTMLInputElement>('.explorer-panel__new input');
        await act(async () => {
            // The explorer is rooted at the source folder, so a name is all it is given.
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
                field,
                'enemy.ts',
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
        await until(() => api.saves.length === 1);
        expect(api.saves[0]?.sources.map((source) => source.path)).toContain('src/enemy.ts');

        await remove(host, 'enemy.ts');
        await press(host, 'Save');
        await until(() => api.saves.length === 2);
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

    it('puts what the service holds back into the code editor on a reload', async () => {
        const api = fakeApi();
        await stored(api, [draftFromText('src/main.ts', 'const a = 1;')], 1);
        const host = await reopened(api);

        await type('src/main.ts', 'const a = 2;');
        api.workspaceState = { ...api.workspaceState, revision: 7 };
        await press(host, 'Save');
        await until(() => state(host)?.includes('reloaded') === true);

        // Without this the screen keeps the text that lost, and the next keystroke saves it over
        // the one that won.
        const reset = workbench().resetFiles.mock.lastCall?.[0] as {
            path: string;
            value: string;
        }[];
        expect(reset.find((file) => file.path === 'src/main.ts')?.value).toBe('const a = 1;');
        expect(reset.some((file) => file.path === PROJECT_PATH)).toBe(false);

        const saves = api.saves.length;
        await press(host, 'Save');
        expect(api.saves.length).toBe(saves);
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
        expect(state(host)).toBe('your Grove session ended; this saves once you sign in again');
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
        await visibility('hidden');

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

describe('one save at a time', () => {
    it('holds a save asked for mid-flight until the first lands, then sends it on top', async () => {
        vi.useFakeTimers();
        try {
            const api = fakeApi();
            await stored(api, [draftFromText('src/main.ts', 'const a = 1;')]);
            const host = await reopened(api);

            const real = api.save.bind(api);
            const sent: number[] = [];
            let release!: () => void;
            const held = new Promise<void>((resolve) => (release = resolve));
            api.save = async (game, save) => {
                sent.push(save.baseRevision);
                if (sent.length === 1) await held;
                return real(game, save);
            };

            await type('src/main.ts', 'const a = 2;');
            await press(host, 'Save');
            // Typed while the first is in flight, and saved on its own once the typing stops.
            await type('src/main.ts', 'const a = 3;');
            await act(async () => {
                await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
            });
            expect(sent).toEqual([1]);

            await act(async () => {
                release();
                await vi.advanceTimersByTimeAsync(0);
            });

            // The second went at the revision the first landed as, so nothing was a conflict and
            // nothing reloaded the typing away.
            expect(sent).toEqual([1, 2]);
            expect(api.saves.map((save) => save.sources[0]?.text)).toEqual([
                'const a = 2;',
                'const a = 3;',
            ]);
            expect(state(host)).toBe('Saved');
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('the save a closing tab sends', () => {
    it('keeps its text edits and leaves out an asset it had no time to upload', async () => {
        const api = fakeApi();
        await stored(api, [draftFromText('src/main.ts', 'const a = 1;')]);
        const host = await reopened(api);
        const flushed = vi.spyOn(api, 'saveOnExit');

        await type('src/main.ts', 'const a = 2;');
        const picker = host.querySelector<HTMLInputElement>('input[type="file"]');
        const art = new File([new Uint8Array([137, 80, 78, 71])], 'tile.png', {
            type: 'image/png',
        });
        await act(async () => {
            Object.defineProperty(picker, 'files', { value: [art], configurable: true });
            picker?.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await until(() => paths(host).includes('tile.png'));

        await visibility('hidden');

        const save = flushed.mock.calls[0]?.[1];
        expect(save?.assets).toEqual([]);
        expect(save?.sources.map((source) => source.path)).toEqual(['src/main.ts']);
        // Which the service takes, where naming the asset would have refused the text with it.
        await until(() => api.saves.length === 1);
    });
});

describe('importing a file', () => {
    it('trusts the extension over what the browser reported for it', async () => {
        const api = fakeApi();
        await stored(api, [draftFromText('src/main.ts', 'const a = 1;')]);
        const host = await reopened(api);

        // A .ts file is `video/mp2t` in an OS media registry, and a browser reports that.
        const script = new File(['export const b = 1;'], 'enemy.ts', { type: 'video/mp2t' });
        const picker = host.querySelector<HTMLInputElement>('input[type="file"]');
        await act(async () => {
            Object.defineProperty(picker, 'files', { value: [script], configurable: true });
            picker?.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await until(() => paths(host).includes('enemy.ts'));

        await press(host, 'Save');
        await until(() => api.saves.length === 1);
        expect(api.saves[0]?.sources).toContainEqual({
            path: 'enemy.ts',
            contentType: 'text/typescript',
            text: 'export const b = 1;',
        });
        expect(api.saves[0]?.assets).toEqual([]);
    });
});

/** Picks a file through the explorer's own input, the way the import button does. */
async function pick(host: HTMLElement, file: File): Promise<void> {
    const picker = host.querySelector<HTMLInputElement>('input[type="file"]');
    await act(async () => {
        Object.defineProperty(picker, 'files', { value: [file], configurable: true });
        picker?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => paths(host).includes(file.name));
}

function artFile(name = 'tile.png'): File {
    return new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
}

describe('a tab that was hidden and came back', () => {
    it('saves what was typed after it at the revision its exit save landed as', async () => {
        const api = fakeApi();
        await stored(api, [draftFromText('src/main.ts', 'const a = 1;')], 1);
        const host = await reopened(api);

        await type('src/main.ts', 'const a = 2;');
        await visibility('hidden');
        await until(() => state(host) === 'Saved');
        await visibility('visible');
        await type('src/main.ts', 'const a = 3;');
        await press(host, 'Save');
        await until(() => api.saves.length === 2);

        // Without adopting the exit save's answer the second would name revision 1 and lose to it.
        expect(api.saves.map((save) => save.baseRevision)).toEqual([1, 2]);
        expect(api.saves[1]?.sources[0]?.text).toBe('const a = 3;');
        await until(() => state(host) === 'Saved');
        expect(workbench().resetFiles).not.toHaveBeenCalled();
    });

    it('takes its own exit save landing first for what it is, not for somebody else', async () => {
        const api = fakeApi();
        await stored(api, [draftFromText('src/main.ts', 'const a = 1;')], 1);
        const host = await reopened(api);
        const real = api.save.bind(api);
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        api.save = async (game, save) => {
            await held;
            return real(game, save);
        };

        await type('src/main.ts', 'const a = 2;');
        await press(host, 'Save');
        await type('src/main.ts', 'const a = 3;');
        // The exit save goes while the first is still out, and lands at revision 2 before it.
        await visibility('hidden');
        await until(() => api.saves.length === 1);
        await act(async () => {
            release();
        });
        await until(() => state(host) === 'Saved');

        expect(workbench().resetFiles).not.toHaveBeenCalled();
        expect(api.saves.map((save) => save.sources[0]?.text)).toEqual(['const a = 3;']);
        expect(host.querySelector('.topbar__save')?.getAttribute('aria-disabled')).toBe('true');
    });
});

describe('a game opened on a template', () => {
    it('is not saved for being opened, whatever the clock or the tab does', async () => {
        vi.useFakeTimers();
        try {
            const api = fakeApi();
            const host = await shell(api);

            await act(async () => {
                await vi.advanceTimersByTimeAsync(SAVE_CEILING_MS + SAVE_DEBOUNCE_MS);
            });
            await visibility('hidden');
            const unload = new Event('beforeunload', { cancelable: true });
            window.dispatchEvent(unload);

            expect(api.saves).toEqual([]);
            expect(unload.defaultPrevented).toBe(false);
            // Still offered: the first save is the creator's, and Save is how they ask for it.
            expect(state(host)).toBe('Unsaved changes');
        } finally {
            vi.useRealTimers();
        }
    });

    it('is not saved for being played, since its code declares what its manifest already says', async () => {
        const api = fakeApi();
        // Opened the way Boot opens it, so its manifest carries a real stamp rather than a fixture's.
        const host = await reopened(api);

        await press(host, 'Play');
        await until(() => host.querySelector('.play-frame')?.getAttribute('src') !== null, 10_000);
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, SAVE_DEBOUNCE_MS + 300));
        });

        expect(api.saves).toEqual([]);
        expect(state(host)).toBe('Unsaved changes');
    });

    it('is saved whole once the creator edits it', async () => {
        vi.useFakeTimers();
        try {
            const api = fakeApi();
            await shell(api);

            await type(TEMPLATE_PATH, 'const a = 2;');
            await act(async () => {
                await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
            });

            expect(api.saves).toHaveLength(1);
            expect(api.saves[0]?.sources.map((source) => source.path)).toEqual([
                TEMPLATE_PATH,
                PROJECT_PATH,
            ]);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('an asset that would not upload', () => {
    it('leaves the text beside it saved, and says which file held back', async () => {
        const api = fakeApi();
        await stored(api, [draftFromText('src/main.ts', 'const a = 1;')]);
        const host = await reopened(api);
        vi.spyOn(api, 'putAsset').mockRejectedValue(
            new ApiError(503, 'internal', 'tile.png could not be uploaded'),
        );

        await type('src/main.ts', 'const a = 2;');
        await pick(host, artFile());
        await press(host, 'Save');
        await until(() => state(host) !== 'Saving…');

        expect(api.saves).toHaveLength(1);
        expect(api.saves[0]?.sources.map((source) => source.path)).toEqual(['src/main.ts']);
        expect(api.saves[0]?.assets).toEqual([]);
        expect(state(host)).toBe('tile.png could not be uploaded; everything else saved');
    });

    it('is tried again by Save, and never by a save nobody asked for', async () => {
        vi.useFakeTimers();
        try {
            const api = fakeApi();
            await stored(api, [draftFromText('src/main.ts', 'const a = 1;')]);
            const host = await reopened(api);
            const put = vi
                .spyOn(api, 'putAsset')
                .mockRejectedValueOnce(
                    new ApiError(503, 'internal', 'tile.png could not be uploaded'),
                );

            await pick(host, artFile());
            await press(host, 'Save');
            await act(async () => {
                await vi.advanceTimersByTimeAsync(0);
            });
            expect(put).toHaveBeenCalledTimes(1);

            await type('src/main.ts', 'const a = 2;');
            await act(async () => {
                await vi.advanceTimersByTimeAsync(SAVE_CEILING_MS + SAVE_DEBOUNCE_MS);
            });
            // The text went on its own; the bytes that failed did not go with it.
            expect(api.saves.at(-1)?.sources.map((source) => source.path)).toEqual(['src/main.ts']);
            expect(put).toHaveBeenCalledTimes(1);

            await press(host, 'Save');
            await act(async () => {
                await vi.advanceTimersByTimeAsync(0);
            });
            expect(put).toHaveBeenCalledTimes(2);
            expect(api.saves.at(-1)?.assets).toEqual(['tile.png']);
            expect(state(host)).toBe('Saved');
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('a session another tab signed in to', () => {
    it('saves on the token a fresh read hands back, rather than failing on the stale one', async () => {
        const api = fakeApi();
        await stored(api, [draftFromText('src/main.ts', 'const a = 1;')]);
        const host = await reopened(api);
        api.signInElsewhere();

        await type('src/main.ts', 'const a = 2;');
        await press(host, 'Save');
        await until(() => state(host) === 'Saved');

        expect(api.saves).toHaveLength(1);
        // Refused on the stale token, the session read again, and the save sent once more.
        expect(api.requests.filter((request) => request.startsWith('PUT'))).toHaveLength(2);
    });

    it('waits out a lapse, and saves what is owed once the creator comes back signed in', async () => {
        const api = fakeApi();
        const lapsed = vi.fn();
        await stored(api, [draftFromText('src/main.ts', 'const a = 1;')]);
        const host = await reopened(api, lapsed);
        api.signedIn = false;

        await type('src/main.ts', 'const a = 2;');
        await press(host, 'Save');
        await until(() => lapsed.mock.calls.length === 1);
        // Off to the other tab to sign in, which is a new session and a new token.
        await visibility('hidden');
        api.signInElsewhere();
        await visibility('visible');
        await until(() => state(host) === 'Saved');

        expect(api.saves.map((save) => save.sources[0]?.text)).toEqual(['const a = 2;']);
        expect(lapsed).toHaveBeenCalledTimes(1);
    });
});
