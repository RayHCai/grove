import { act, createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Wordmark } from '../src/components/Wordmark.js';
import { mount } from './helpers.js';

describe('Wordmark', () => {
    it('is a span reading Grove after a hidden leaf icon when it has nowhere to link', async () => {
        const host = await mount(<Wordmark />);
        const el = host.firstElementChild;
        expect(el?.tagName).toBe('SPAN');
        expect(el?.className).toBe('pg-wordmark');
        expect(el?.hasAttribute('href')).toBe(false);
        expect(el?.textContent).toBe('Grove');
        const leaf = el?.firstElementChild;
        expect(leaf?.className).toBe('pg-wordmark__leaf');
        expect(leaf?.getAttribute('aria-hidden')).toBe('true');
        expect(leaf?.textContent).toBe('');
        const icon = leaf?.querySelector('svg');
        expect(icon?.getAttribute('class')).toBe('pg-icon');
        expect(icon?.getAttribute('width')).toBe('16');
        expect(icon?.getAttribute('height')).toBe('16');
        expect(icon?.getAttribute('aria-hidden')).toBe('true');
    });

    it('is a link when given an href', async () => {
        const host = await mount(<Wordmark href="/" />);
        const el = host.firstElementChild;
        expect(el?.tagName).toBe('A');
        expect(el?.getAttribute('href')).toBe('/');
        expect(el?.className).toBe('pg-wordmark');
        expect(el?.textContent).toBe('Grove');
    });

    it('lets children replace the name, keeps the class it is given and passes the ref', async () => {
        const ref = createRef<HTMLAnchorElement>();
        const host = await mount(
            <Wordmark href="/" className="brand" aria-label="Grove home" ref={ref}>
                Grove Editor
            </Wordmark>,
        );
        const el = host.querySelector('a');
        expect(el?.className).toBe('pg-wordmark brand');
        expect(el?.textContent).toBe('Grove Editor');
        expect(el?.getAttribute('aria-label')).toBe('Grove home');
        expect(ref.current).toBe(el);
    });

    it('passes native handlers through to the span form', async () => {
        const onClick = vi.fn();
        const host = await mount(<Wordmark onClick={onClick} />);
        const el = host.querySelector('span');
        await act(async () => {
            el?.click();
        });
        expect(onClick).toHaveBeenCalledOnce();
    });
});
