import { act, createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TextInput } from '../src/components/TextInput.js';
import { mount } from './helpers.js';

describe('TextInput', () => {
    it('is a labelled input whose label points at a generated id', async () => {
        const host = await mount(<TextInput label="Pick a nickname" />);
        const label = host.querySelector('label');
        const input = host.querySelector('input');
        expect(host.firstElementChild?.className).toBe('pg-field');
        expect(label?.className).toBe('pg-field__label');
        expect(label?.textContent).toBe('Pick a nickname');
        expect(input?.className).toBe('pg-field__control');
        expect(input?.id).not.toBe('');
        expect(label?.getAttribute('for')).toBe(input?.id);
        expect(input?.hasAttribute('aria-describedby')).toBe(false);
        expect(host.querySelector('.pg-field__hint')).toBeNull();
    });

    it('keeps the id, class and native attributes it is given and hands the ref to the input', async () => {
        const ref = createRef<HTMLInputElement>();
        const host = await mount(
            <TextInput
                label="Nickname"
                id="nick"
                name="nick"
                type="text"
                placeholder="mossy_pip"
                autoComplete="off"
                className="wide"
                ref={ref}
            />,
        );
        const input = host.querySelector('input');
        expect(host.firstElementChild?.className).toBe('pg-field wide');
        expect(input?.id).toBe('nick');
        expect(host.querySelector('label')?.getAttribute('for')).toBe('nick');
        expect(input?.getAttribute('name')).toBe('nick');
        expect(input?.getAttribute('type')).toBe('text');
        expect(input?.getAttribute('placeholder')).toBe('mossy_pip');
        expect(input?.getAttribute('autocomplete')).toBe('off');
        expect(ref.current).toBe(input);
    });

    it('hides the label from sight but not from the input when asked', async () => {
        const host = await mount(<TextInput label="Search" labelHidden />);
        const label = host.querySelector('label');
        expect(label?.className).toBe('pg-visually-hidden');
        expect(label?.textContent).toBe('Search');
        expect(label?.getAttribute('for')).toBe(host.querySelector('input')?.id);
    });

    it('renders a hint under the control and describes the input by it', async () => {
        const host = await mount(
            <TextInput label="Nickname" id="nick" hint="Letters and underscores only." />,
        );
        const input = host.querySelector('input');
        const hint = host.querySelector('.pg-field__hint');
        expect(hint?.tagName).toBe('P');
        expect(hint?.id).toBe('nick-hint');
        expect(hint?.textContent).toBe('Letters and underscores only.');
        expect(input?.nextElementSibling).toBe(hint);
        expect(input?.getAttribute('aria-describedby')).toBe('nick-hint');
    });

    it('adds the hint to a description the caller already set', async () => {
        const host = await mount(
            <TextInput label="Nickname" id="nick" hint="Be kind." aria-describedby="rules" />,
        );
        expect(host.querySelector('input')?.getAttribute('aria-describedby')).toBe(
            'rules nick-hint',
        );
    });

    it('leaves a caller description alone when there is no hint', async () => {
        const host = await mount(<TextInput label="Message" aria-describedby="status" />);
        expect(host.querySelector('input')?.getAttribute('aria-describedby')).toBe('status');
    });

    it('passes disabled and readOnly through as native attributes', async () => {
        const host = await mount(
            <>
                <TextInput label="Locked" disabled />
                <TextInput label="Fixed" readOnly />
            </>,
        );
        const inputs = host.querySelectorAll('input');
        expect(inputs[0]?.disabled).toBe(true);
        expect(inputs[0]?.readOnly).toBe(false);
        expect(inputs[1]?.disabled).toBe(false);
        expect(inputs[1]?.readOnly).toBe(true);
    });

    it('hands keyboard events to the handler it is given', async () => {
        const onKeyDown = vi.fn();
        const host = await mount(<TextInput label="Nickname" onKeyDown={onKeyDown} />);
        const input = host.querySelector('input');
        await act(async () => {
            input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        });
        expect(onKeyDown).toHaveBeenCalledOnce();
        expect(onKeyDown.mock.calls[0]?.[0]?.key).toBe('a');
    });
});
