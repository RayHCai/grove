import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectSettings } from '@platform/project';
import { SettingsPanel } from '../src/settings/SettingsPanel';
import { PROJECT } from './doubles';
import { mount } from './helpers';

async function panel(
    onChange: (settings: ProjectSettings) => void = vi.fn(),
    onClose = vi.fn(),
): Promise<HTMLElement> {
    return mount(<SettingsPanel open project={PROJECT} onChange={onChange} onClose={onClose} />);
}

function field(host: HTMLElement, label: string): HTMLInputElement {
    const found = [...host.querySelectorAll('label')].find((each) => each.textContent === label);
    const control =
        found === null ? null : host.querySelector<HTMLInputElement>(`#${found?.htmlFor ?? ''}`);
    if (control === null || control === undefined) throw new Error(`no field called ${label}`);
    return control;
}

/** Types into a field the way a browser does: the value is set, then one input event. */
async function type(control: HTMLInputElement, value: string): Promise<void> {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
            control,
            value,
        );
        control.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

describe('SettingsPanel', () => {
    it('is a named aside holding the manifest a creator sets', async () => {
        const host = await panel();
        const aside = host.querySelector('aside');
        expect(aside?.id).toBe('settings-panel');
        expect(aside?.getAttribute('aria-label')).toBe('Project settings');
        expect(field(host, 'Players').value).toBe(String(PROJECT.settings.maxPlayers));
        expect(field(host, 'Sim rate').value).toBe(String(PROJECT.settings.simRate));
        expect(field(host, 'Send rate').value).toBe(String(PROJECT.settings.sendRate));
        expect(field(host, 'Left').value).toBe(String(PROJECT.settings.bounds.left));
    });

    it('stays mounted and hidden while it is closed', async () => {
        const host = await mount(
            <SettingsPanel open={false} project={PROJECT} onChange={vi.fn()} onClose={vi.fn()} />,
        );
        const aside = host.querySelector('aside');
        expect(aside?.hidden).toBe(true);
        expect(aside?.getAttribute('data-open')).toBe('false');
    });

    it('hands one edited settings block up, leaving the rest of the manifest alone', async () => {
        const onChange = vi.fn();
        const host = await panel(onChange);

        await type(field(host, 'Players'), '8');
        expect(onChange).toHaveBeenLastCalledWith({ ...PROJECT.settings, maxPlayers: 8 });

        await type(field(host, 'Right'), '600');
        expect(onChange).toHaveBeenLastCalledWith({
            ...PROJECT.settings,
            bounds: { ...PROJECT.settings.bounds, right: 600 },
        });
    });

    it('keeps a half-typed value out of the game, and marks the field while it is not one', async () => {
        const onChange = vi.fn();
        const host = await panel(onChange);
        const players = field(host, 'Players');

        await type(players, '');
        expect(onChange).not.toHaveBeenCalled();
        expect(players.getAttribute('aria-invalid')).toBe('true');

        // A rate is a positive whole number; the format refuses anything else outright.
        await type(players, '2.5');
        expect(onChange).not.toHaveBeenCalled();

        await type(players, '3');
        expect(onChange).toHaveBeenCalledOnce();
        expect(players.hasAttribute('aria-invalid')).toBe(false);
    });

    it('shows again what the manifest holds once the field is left', async () => {
        const host = await panel();
        const players = field(host, 'Players');
        await type(players, '');
        await act(async () => {
            // React hears onBlur through focusout, which is the one that bubbles.
            players.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        });
        expect(players.value).toBe(String(PROJECT.settings.maxPlayers));
    });

    it('reports what the code declares, which is the compile’s to write', async () => {
        const host = await panel();
        expect(host.querySelector('.settings-panel__note')?.textContent).toContain(
            '2 scripts in 1 file',
        );
    });

    it('closes on Escape and from the close button', async () => {
        const onClose = vi.fn();
        const host = await panel(vi.fn(), onClose);
        await act(async () => {
            host.querySelector('aside')?.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
            );
        });
        expect(onClose).toHaveBeenCalledOnce();

        await act(async () => {
            host.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click();
        });
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});
