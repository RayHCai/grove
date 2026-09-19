import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ModeSelect } from '../src/shell/ModeSelect';
import { mount } from './helpers';

async function open(host: HTMLElement): Promise<void> {
    await act(async () => {
        host.querySelector<HTMLButtonElement>('[role="combobox"]')?.click();
    });
}

describe('ModeSelect', () => {
    it('is a small combobox named Mode, its label hidden, showing TypeScript', async () => {
        const host = await mount(<ModeSelect value="ts" onChange={vi.fn()} />);
        const trigger = host.querySelector<HTMLElement>('[role="combobox"]');
        const label = host.querySelector('#editor-mode-label');
        expect(label?.textContent).toBe('Mode');
        expect(label?.className).toBe('pg-visually-hidden');
        expect(host.querySelector('.pg-select__label')).toBeNull();
        expect(trigger?.getAttribute('aria-labelledby')).toBe(
            'editor-mode-label editor-mode-value',
        );
        expect(trigger?.title).toBe('Mode');
        expect(trigger?.classList.contains('pg-btn--sm')).toBe(true);
        expect(host.querySelector('#editor-mode-value')?.textContent).toBe('TypeScript');
        expect(host.querySelector('.pg-select')?.className).toBe(
            'pg-select pg-select--end mode-select',
        );
    });

    it('keeps the class it is given after its own', async () => {
        const host = await mount(<ModeSelect value="ts" onChange={vi.fn()} className="cell" />);
        expect(host.querySelector('.pg-select')?.className).toBe(
            'pg-select pg-select--end mode-select cell',
        );
    });

    it('lists TypeScript and Blocks, with Blocks disabled and described as coming soon', async () => {
        const host = await mount(<ModeSelect value="ts" onChange={vi.fn()} />);
        await open(host);
        const list = host.querySelector<HTMLElement>('[role="listbox"]');
        expect(list?.hidden).toBe(false);
        const options = host.querySelectorAll('[role="option"]');
        expect(options.length).toBe(2);
        expect(options[0]?.textContent).toBe('TypeScript');
        expect(options[0]?.getAttribute('aria-selected')).toBe('true');
        expect(options[1]?.getAttribute('aria-disabled')).toBe('true');
        expect(options[1]?.querySelector('.pg-select__description')?.textContent).toBe(
            'Coming soon',
        );
        expect(options[0]?.querySelector('svg')).not.toBeNull();
        expect(options[1]?.querySelector('svg')).not.toBeNull();
    });

    it('never changes to Blocks', async () => {
        const onChange = vi.fn();
        const host = await mount(<ModeSelect value="ts" onChange={onChange} />);
        await open(host);
        await act(async () => {
            host.querySelectorAll<HTMLElement>('[role="option"]')[1]?.click();
        });
        expect(onChange).not.toHaveBeenCalled();
        expect(host.querySelector<HTMLElement>('[role="listbox"]')?.hidden).toBe(false);
    });
});
