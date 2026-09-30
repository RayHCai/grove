import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SAVED_FADE_MS, TopBar } from '../src/shell/TopBar';
import type { SaveState, TopBarProps } from '../src/shell/TopBar';
import { mount } from './helpers';

function bar(over: Partial<TopBarProps> = {}): Promise<HTMLElement> {
    return mount(
        <TopBar
            title="Pip's Garden"
            displayName="Rowan"
            dirty={false}
            state={{ at: 'idle' }}
            onSave={vi.fn()}
            profileHref="https://grove.example/profile"
            {...over}
        />,
    );
}

function status(host: HTMLElement): string | undefined {
    return host.querySelector('[role="status"]')?.textContent ?? undefined;
}

function faded(host: HTMLElement): boolean | undefined {
    return host.querySelector('[role="status"]')?.classList.contains('topbar__state--faded');
}

function button(host: HTMLElement, label: string): HTMLButtonElement | null {
    return [...host.querySelectorAll('button')].find((each) => each.textContent === label) ?? null;
}

describe('TopBar', () => {
    it('is the header: a hidden heading, the wordmark, and the game being edited', async () => {
        const host = await bar();
        const header = host.querySelector('header');
        expect(header?.className).toBe('topbar');
        const [heading, wordmark, title] = header?.children ?? [];
        expect(heading?.tagName).toBe('H1');
        expect(heading?.textContent).toBe('Grove editor');
        expect(heading?.className).toBe('pg-visually-hidden');
        expect(wordmark?.className).toBe('pg-wordmark');
        expect(wordmark?.textContent).toBe('Grove');
        expect(title?.textContent).toBe("Pip's Garden");
    });

    it('carries no mode select or run controls', async () => {
        const host = await bar();
        expect(host.querySelector('[role="combobox"]')).toBeNull();
        expect(host.querySelector('[role="group"]')).toBeNull();
    });

    it('names the person signed in, ends on them, and goes to where they sign out', async () => {
        const host = await bar();
        const profile = host.querySelector<HTMLAnchorElement>('.topbar__profile');
        expect(profile?.tagName).toBe('A');
        expect(profile?.getAttribute('aria-label')).toBe('Rowan: profile and sign out');
        expect(profile?.getAttribute('href')).toBe('https://grove.example/profile');
        expect(host.querySelector('header')?.lastElementChild).toBe(profile);
    });

    it('says what a save last did, and says it in the wording of each outcome', async () => {
        expect(status(await bar())).toBe('Up to date');
        expect(status(await bar({ dirty: true }))).toBe('Unsaved changes');
        expect(status(await bar({ state: { at: 'saving' } }))).toBe('Saving…');
        expect(status(await bar({ state: { at: 'saved' } }))).toBe('Saved');
    });

    it('fades "Saved" after ten seconds, and only "Saved"', async () => {
        vi.useFakeTimers();
        try {
            const saved = await bar({ state: { at: 'saved' } });
            await act(async () => vi.advanceTimersByTime(SAVED_FADE_MS - 1));
            expect(faded(saved)).toBe(false);
            await act(async () => vi.advanceTimersByTime(1));
            expect(faded(saved)).toBe(true);
            expect(status(saved)).toBe('Saved');

            const saving = await bar({ state: { at: 'saving' } });
            await act(async () => vi.advanceTimersByTime(SAVED_FADE_MS));
            expect(faded(saving)).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('shows the service’s own words for a refusal, and marks them as one', async () => {
        const state: SaveState = { at: 'failed', message: 'the workspace is at revision 3' };
        const host = await bar({ state });
        expect(status(host)).toBe('the workspace is at revision 3');
        expect(host.querySelector('[role="status"]')?.className).toContain('topbar__state--failed');
    });

    it('offers no save while there is nothing to save', async () => {
        expect(button(await bar(), 'Save')?.getAttribute('aria-disabled')).toBe('true');
        const dirty = await bar({ dirty: true });
        expect(button(dirty, 'Save')?.hasAttribute('aria-disabled')).toBe(false);
    });

    it('refuses the save while one is still in flight', async () => {
        const host = await bar({ dirty: true, state: { at: 'saving' } });
        expect(button(host, 'Save')?.getAttribute('aria-disabled')).toBe('true');
    });

    it('hands the save to the caller', async () => {
        const onSave = vi.fn();
        const host = await bar({ dirty: true, onSave });

        await act(async () => {
            button(host, 'Save')?.click();
        });
        expect(onSave).toHaveBeenCalledOnce();
    });
});
