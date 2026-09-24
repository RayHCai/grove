import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider.js';
import type { ThemePreference } from '../src/theme/ThemeProvider.js';
import { mountRoot } from './helpers.js';

function Probe(): React.JSX.Element {
    const { theme, preference, setPreference } = useTheme();
    const option = (next: ThemePreference) => (
        <button type="button" data-choose={next} onClick={() => setPreference(next)}>
            {next}
        </button>
    );
    return (
        <>
            <output data-theme={theme} data-preference={preference} />
            {option('light')}
            {option('dark')}
            {option('system')}
        </>
    );
}

function readProbe(host: HTMLElement): {
    theme: string | undefined;
    preference: string | undefined;
} {
    const output = host.querySelector('output');
    return { theme: output?.dataset.theme, preference: output?.dataset.preference };
}

async function choose(host: HTMLElement, next: ThemePreference): Promise<void> {
    await act(async () => {
        host.querySelector<HTMLButtonElement>(`[data-choose='${next}']`)?.click();
    });
}

function stubMatchMedia(initial: boolean): {
    set: (matches: boolean) => void;
    listeners: Set<() => void>;
} {
    const state = { matches: initial };
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', () => ({
        get matches() {
            return state.matches;
        },
        addEventListener: (_type: string, listener: () => void) => {
            listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: () => void) => {
            listeners.delete(listener);
        },
    }));
    return {
        set(matches) {
            state.matches = matches;
            for (const listener of listeners) listener();
        },
        listeners,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('ThemeProvider', () => {
    it('defaults to system and resolves it to light where matchMedia does not exist', async () => {
        const { host } = await mountRoot(
            <ThemeProvider>
                <Probe />
            </ThemeProvider>,
        );
        expect(readProbe(host)).toEqual({ theme: 'light', preference: 'system' });
        expect(document.documentElement.dataset.theme).toBe('light');
    });

    it('follows the OS while the preference is system', async () => {
        const media = stubMatchMedia(true);
        const { host } = await mountRoot(
            <ThemeProvider>
                <Probe />
            </ThemeProvider>,
        );
        expect(readProbe(host).theme).toBe('dark');
        expect(document.documentElement.dataset.theme).toBe('dark');

        await act(async () => {
            media.set(false);
        });
        expect(readProbe(host).theme).toBe('light');
        expect(document.documentElement.dataset.theme).toBe('light');
    });

    it('starts from the stored preference and persists the one it is given', async () => {
        stubMatchMedia(false);
        localStorage.setItem('grove:theme', 'dark');
        const { host } = await mountRoot(
            <ThemeProvider>
                <Probe />
            </ThemeProvider>,
        );
        expect(readProbe(host)).toEqual({ theme: 'dark', preference: 'dark' });

        await choose(host, 'light');
        expect(readProbe(host)).toEqual({ theme: 'light', preference: 'light' });
        expect(localStorage.getItem('grove:theme')).toBe('light');
        expect(document.documentElement.dataset.theme).toBe('light');

        await choose(host, 'system');
        expect(readProbe(host)).toEqual({ theme: 'light', preference: 'system' });
        expect(localStorage.getItem('grove:theme')).toBe('system');
    });

    it('treats an unknown stored value as system', async () => {
        localStorage.setItem('grove:theme', 'neon');
        const { host } = await mountRoot(
            <ThemeProvider>
                <Probe />
            </ThemeProvider>,
        );
        expect(readProbe(host).preference).toBe('system');
    });

    it('stops listening to the OS when unmounted', async () => {
        const media = stubMatchMedia(false);
        const { root } = await mountRoot(
            <ThemeProvider>
                <Probe />
            </ThemeProvider>,
        );
        expect(media.listeners.size).toBe(1);
        await act(async () => {
            root.unmount();
        });
        expect(media.listeners.size).toBe(0);
    });
});

describe('useTheme', () => {
    it('throws outside a provider', async () => {
        const host = document.createElement('div');
        document.body.append(host);
        let caught: unknown;
        const root = createRoot(host, {
            onUncaughtError: (error) => {
                caught = error;
            },
        });
        try {
            await act(async () => {
                root.render(<Probe />);
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toMatch(/inside a ThemeProvider/);
    });
});
