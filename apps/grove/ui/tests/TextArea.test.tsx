import { act, createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TextArea } from '../src/components/TextArea.js';
import { mount } from './helpers.js';

describe('TextArea', () => {
    it('is a labelled textarea in a field wearing the area modifier', async () => {
        const host = await mount(<TextArea label="Tell us about your game" />);
        const label = host.querySelector('label');
        const area = host.querySelector('textarea');
        expect(host.firstElementChild?.className).toBe('pg-field pg-field--area');
        expect(label?.className).toBe('pg-field__label');
        expect(label?.textContent).toBe('Tell us about your game');
        expect(area?.className).toBe('pg-field__control');
        expect(area?.id).not.toBe('');
        expect(label?.getAttribute('for')).toBe(area?.id);
        expect(area?.hasAttribute('aria-describedby')).toBe(false);
    });

    it('keeps the id, class, rows and native attributes it is given and hands the ref over', async () => {
        const ref = createRef<HTMLTextAreaElement>();
        const host = await mount(
            <TextArea
                label="Story"
                id="story"
                name="story"
                rows={6}
                placeholder="Once upon a seed"
                className="tall"
                ref={ref}
            />,
        );
        const area = host.querySelector('textarea');
        expect(host.firstElementChild?.className).toBe('pg-field pg-field--area tall');
        expect(area?.id).toBe('story');
        expect(host.querySelector('label')?.getAttribute('for')).toBe('story');
        expect(area?.getAttribute('name')).toBe('story');
        expect(area?.getAttribute('rows')).toBe('6');
        expect(area?.getAttribute('placeholder')).toBe('Once upon a seed');
        expect(ref.current).toBe(area);
    });

    it('hides the label from sight but not from the textarea when asked', async () => {
        const host = await mount(<TextArea label="Message Grove AI" labelHidden />);
        const label = host.querySelector('label');
        expect(label?.className).toBe('pg-visually-hidden');
        expect(label?.textContent).toBe('Message Grove AI');
        expect(label?.getAttribute('for')).toBe(host.querySelector('textarea')?.id);
    });

    it('renders a hint under the control and describes the textarea by it', async () => {
        const host = await mount(<TextArea label="Story" id="story" hint="Up to 500 letters." />);
        const area = host.querySelector('textarea');
        const hint = host.querySelector('.pg-field__hint');
        expect(hint?.tagName).toBe('P');
        expect(hint?.id).toBe('story-hint');
        expect(hint?.textContent).toBe('Up to 500 letters.');
        expect(area?.nextElementSibling).toBe(hint);
        expect(area?.getAttribute('aria-describedby')).toBe('story-hint');
    });

    it('adds the hint to a description the caller already set', async () => {
        const host = await mount(
            <TextArea label="Story" id="story" hint="Be kind." aria-describedby="rules" />,
        );
        expect(host.querySelector('textarea')?.getAttribute('aria-describedby')).toBe(
            'rules story-hint',
        );
    });

    it('stays focusable when readOnly and keeps the description it was handed', async () => {
        const host = await mount(
            <TextArea
                label="Message Grove AI"
                labelHidden
                readOnly
                aria-describedby="ai-status"
                placeholder="Chat is coming soon"
            />,
        );
        const area = host.querySelector('textarea');
        expect(area?.readOnly).toBe(true);
        expect(area?.disabled).toBe(false);
        expect(area?.getAttribute('aria-describedby')).toBe('ai-status');
        await act(async () => {
            area?.focus();
        });
        expect(document.activeElement).toBe(area);
    });

    it('renders disabled as the native attribute', async () => {
        const host = await mount(<TextArea label="Locked" disabled />);
        expect(host.querySelector('textarea')?.disabled).toBe(true);
    });

    it('hands keyboard events to the handler it is given', async () => {
        const onKeyDown = vi.fn();
        const host = await mount(<TextArea label="Story" onKeyDown={onKeyDown} />);
        const area = host.querySelector('textarea');
        await act(async () => {
            area?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        expect(onKeyDown).toHaveBeenCalledOnce();
        expect(onKeyDown.mock.calls[0]?.[0]?.key).toBe('Enter');
    });
});
