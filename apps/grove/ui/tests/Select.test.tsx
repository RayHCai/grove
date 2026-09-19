import { act, createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Select } from '../src/components/Select.js';
import type { SelectOption } from '../src/components/Select.js';
import { CodeIcon } from '../src/icons/CodeIcon.js';
import { mount } from './helpers.js';

const modes: SelectOption[] = [
    { value: 'ts', label: 'TypeScript', icon: <CodeIcon /> },
    { value: 'blocks', label: 'Blocks', disabled: true, description: 'Coming soon' },
    { value: 'py', label: 'Python' },
];

async function press(el: Element | null, key: string, init: KeyboardEventInit = {}): Promise<void> {
    await act(async () => {
        el?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
    });
}

async function click(el: HTMLElement | null): Promise<void> {
    await act(async () => {
        el?.click();
    });
}

function optionIds(host: HTMLElement): string[] {
    return [...host.querySelectorAll('[role="option"]')].map((option) => option.id);
}

describe('Select', () => {
    it('is a combobox trigger dressed as a small secondary button, named by its label and value', async () => {
        const host = await mount(
            <Select label="Mode" value="ts" options={modes} onChange={vi.fn()} id="mode" />,
        );
        const trigger = host.querySelector('button');
        const list = host.querySelector('[role="listbox"]');
        expect(trigger?.className).toBe('pg-btn pg-btn--secondary pg-btn--sm pg-select__trigger');
        expect(trigger?.getAttribute('type')).toBe('button');
        expect(trigger?.getAttribute('role')).toBe('combobox');
        expect(trigger?.getAttribute('aria-haspopup')).toBe('listbox');
        expect(trigger?.getAttribute('aria-expanded')).toBe('false');
        expect(trigger?.getAttribute('aria-controls')).toBe('mode-list');
        expect(trigger?.getAttribute('aria-labelledby')).toBe('mode-label mode-value');
        expect(trigger?.hasAttribute('aria-activedescendant')).toBe(false);
        expect(host.querySelector('#mode-label')?.textContent).toBe('Mode');
        expect(host.querySelector('#mode-value')?.textContent).toBe('TypeScript');
        const icons = trigger?.querySelectorAll('.pg-btn__icon svg') ?? [];
        expect(icons.length).toBe(2);
        expect(icons[0]?.getAttribute('class')).toBe('pg-icon');
        expect(icons[1]?.getAttribute('class')).toBe('pg-icon pg-select__chevron');
        expect(host.querySelector('#mode-label')?.className).toBe('pg-select__label');
        expect(host.firstElementChild?.className).toBe('pg-select');
        expect(list?.id).toBe('mode-list');
        expect(list?.getAttribute('aria-labelledby')).toBe('mode-label');
        expect(list?.className).toBe('pg-panel pg-panel--surface pg-select__list');
        expect((list as HTMLElement | null)?.hidden).toBe(true);
    });

    it('opens on click, keeps focus on the trigger and highlights the selected option', async () => {
        const host = await mount(
            <Select label="Mode" value="ts" options={modes} onChange={vi.fn()} id="mode" />,
        );
        const trigger = host.querySelector('button');
        await act(async () => {
            trigger?.focus();
        });
        await click(trigger);
        const list = host.querySelector<HTMLElement>('[role="listbox"]');
        const options = host.querySelectorAll('[role="option"]');
        expect(trigger?.getAttribute('aria-expanded')).toBe('true');
        expect(list?.hidden).toBe(false);
        expect(document.activeElement).toBe(trigger);
        expect(trigger?.getAttribute('aria-activedescendant')).toBe('mode-option-0');
        expect(options[0]?.getAttribute('aria-selected')).toBe('true');
        expect(options[0]?.className).toBe('pg-select__option pg-select__option--active');
        expect(options[1]?.getAttribute('aria-selected')).toBe('false');
        expect(options[1]?.getAttribute('aria-disabled')).toBe('true');
        expect(options[1]?.textContent).toBe('BlocksComing soon');
        expect(options[1]?.querySelector('.pg-select__description')?.textContent).toBe(
            'Coming soon',
        );
        expect(options[2]?.hasAttribute('aria-disabled')).toBe(false);
        await click(trigger);
        expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    });

    it('opens on ArrowDown and walks onto a disabled option instead of skipping it', async () => {
        const onChange = vi.fn();
        const host = await mount(
            <Select label="Mode" value="ts" options={modes} onChange={onChange} />,
        );
        const trigger = host.querySelector('button');
        await press(trigger, 'ArrowDown');
        const ids = optionIds(host);
        expect(trigger?.getAttribute('aria-expanded')).toBe('true');
        expect(trigger?.getAttribute('aria-activedescendant')).toBe(ids[0]);
        await press(trigger, 'ArrowDown');
        expect(trigger?.getAttribute('aria-activedescendant')).toBe(ids[1]);
        await press(trigger, 'Enter');
        expect(onChange).not.toHaveBeenCalled();
        expect(trigger?.getAttribute('aria-expanded')).toBe('true');
        expect(trigger?.getAttribute('aria-activedescendant')).toBe(ids[1]);
        await press(trigger, 'ArrowDown');
        expect(trigger?.getAttribute('aria-activedescendant')).toBe(ids[2]);
        await press(trigger, 'ArrowDown');
        expect(trigger?.getAttribute('aria-activedescendant')).toBe(ids[2]);
        await press(trigger, 'Home');
        expect(trigger?.getAttribute('aria-activedescendant')).toBe(ids[0]);
        await press(trigger, 'End');
        expect(trigger?.getAttribute('aria-activedescendant')).toBe(ids[2]);
        await press(trigger, 'Enter');
        expect(onChange).toHaveBeenCalledExactlyOnceWith('py');
        expect(trigger?.getAttribute('aria-expanded')).toBe('false');
        expect(trigger?.hasAttribute('aria-activedescendant')).toBe(false);
    });

    it('closes on Escape without a change and leaves focus on the trigger', async () => {
        const onChange = vi.fn();
        const host = await mount(
            <Select label="Mode" value="ts" options={modes} onChange={onChange} />,
        );
        const trigger = host.querySelector('button');
        await act(async () => {
            trigger?.focus();
        });
        await press(trigger, 'Enter');
        await press(trigger, 'ArrowDown');
        await press(trigger, 'ArrowDown');
        await press(trigger, 'Escape');
        expect(trigger?.getAttribute('aria-expanded')).toBe('false');
        expect(host.querySelector<HTMLElement>('[role="listbox"]')?.hidden).toBe(true);
        expect(onChange).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(trigger);
    });

    it('commits the highlighted option on Tab and closes', async () => {
        const onChange = vi.fn();
        const host = await mount(
            <Select label="Mode" value="ts" options={modes} onChange={onChange} />,
        );
        const trigger = host.querySelector('button');
        await press(trigger, ' ');
        await press(trigger, 'End');
        await press(trigger, 'Tab');
        expect(onChange).toHaveBeenCalledExactlyOnceWith('py');
        expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    });

    it('only closes on Tab when the highlighted option is disabled', async () => {
        const onChange = vi.fn();
        const host = await mount(
            <Select label="Mode" value="ts" options={modes} onChange={onChange} />,
        );
        const trigger = host.querySelector('button');
        await press(trigger, 'ArrowDown');
        await press(trigger, 'ArrowDown');
        await press(trigger, 'Tab');
        expect(onChange).not.toHaveBeenCalled();
        expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    });

    it('commits a clicked option, ignores a clicked disabled one, and closes on a press outside', async () => {
        const onChange = vi.fn();
        const host = await mount(
            <Select label="Mode" value="ts" options={modes} onChange={onChange} />,
        );
        const trigger = host.querySelector('button');
        await click(trigger);
        const options = host.querySelectorAll<HTMLElement>('[role="option"]');
        await click(options[1] ?? null);
        expect(onChange).not.toHaveBeenCalled();
        expect(trigger?.getAttribute('aria-expanded')).toBe('true');
        await click(options[2] ?? null);
        expect(onChange).toHaveBeenCalledExactlyOnceWith('py');
        expect(trigger?.getAttribute('aria-expanded')).toBe('false');
        await click(trigger);
        expect(trigger?.getAttribute('aria-expanded')).toBe('true');
        await act(async () => {
            document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        });
        expect(trigger?.getAttribute('aria-expanded')).toBe('false');
        expect(onChange).toHaveBeenCalledOnce();
    });

    it('does not report a change when the current value is chosen again', async () => {
        const onChange = vi.fn();
        const host = await mount(
            <Select label="Mode" value="ts" options={modes} onChange={onChange} />,
        );
        const trigger = host.querySelector('button');
        await press(trigger, 'ArrowDown');
        await press(trigger, 'Enter');
        expect(onChange).not.toHaveBeenCalled();
        expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    });

    it('hides the label visually while keeping it and the value in the name', async () => {
        const host = await mount(
            <Select
                label="Mode"
                labelHidden
                value="ts"
                options={modes}
                onChange={vi.fn()}
                id="mode"
            />,
        );
        const trigger = host.querySelector('button');
        expect(host.querySelector('#mode-label')?.className).toBe('pg-visually-hidden');
        expect(host.querySelector('#mode-value')?.className).toBe('pg-select__value');
        expect(host.querySelector('#mode-value')?.textContent).toBe('TypeScript');
        expect(trigger?.getAttribute('aria-labelledby')).toBe('mode-label mode-value');
    });

    it('takes the medium size, a class on the root and a ref on the trigger', async () => {
        const ref = createRef<HTMLButtonElement>();
        const host = await mount(
            <Select
                label="Mode"
                value="ts"
                options={modes}
                onChange={vi.fn()}
                size="md"
                className="mode"
                ref={ref}
            />,
        );
        const trigger = host.querySelector('button');
        expect(host.firstElementChild?.className).toBe('pg-select mode');
        expect(trigger?.className).toBe('pg-btn pg-btn--secondary pg-select__trigger');
        expect(ref.current).toBe(trigger);
    });

    it('hangs the list from the trailing edge with align="end" and passes a title to the trigger', async () => {
        const host = await mount(
            <Select
                label="Mode"
                labelHidden
                value="ts"
                options={modes}
                onChange={vi.fn()}
                align="end"
                title="Mode"
            />,
        );
        const trigger = host.querySelector('button');
        expect(host.firstElementChild?.className).toBe('pg-select pg-select--end');
        expect(trigger?.getAttribute('title')).toBe('Mode');
        expect(host.querySelector('[role="listbox"]')?.className).toBe(
            'pg-panel pg-panel--surface pg-select__list',
        );
    });

    it('stays closed and inert while aria-disabled', async () => {
        const host = await mount(
            <Select
                label="Mode"
                value="ts"
                options={modes}
                onChange={vi.fn()}
                aria-disabled="true"
            />,
        );
        const trigger = host.querySelector('button');
        await click(trigger);
        await press(trigger, 'ArrowDown');
        expect(trigger?.disabled).toBe(false);
        expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    });
});
