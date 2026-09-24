import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TopBar } from '../src/shell/TopBar';
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
            {...over}
        />,
    );
}

function status(host: HTMLElement): string | undefined {
    return host.querySelector('[role="status"]')?.textContent ?? undefined;
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

    it('names the person signed in rather than a profile nobody holds, and ends on them', async () => {
        const host = await bar();
        const profile = host.querySelector<HTMLButtonElement>('.topbar__profile');
        expect(profile?.getAttribute('aria-label')).toBe('Rowan');
        expect(profile?.hasAttribute('aria-disabled')).toBe(false);
        expect(host.querySelector('header')?.lastElementChild).toBe(profile);
    });

    it('says what a save last did, and says it in the wording of each outcome', async () => {
        expect(status(await bar())).toBe('Up to date');
        expect(status(await bar({ dirty: true }))).toBe('Unsaved changes');
        expect(status(await bar({ state: { at: 'saving' } }))).toBe('Saving…');
        expect(status(await bar({ state: { at: 'saved', revision: 4 } }))).toBe(
            'Saved as revision 4',
        );
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
