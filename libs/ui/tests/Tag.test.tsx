import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { Tag } from '../src/components/Tag.js';
import { mount } from './helpers.js';

describe('Tag', () => {
    it('is a span with the tag class and its text', async () => {
        const host = await mount(<Tag>EDITOR</Tag>);
        const tag = host.firstElementChild;
        expect(tag?.tagName).toBe('SPAN');
        expect(tag?.className).toBe('pg-tag');
        expect(tag?.textContent).toBe('EDITOR');
    });

    it('keeps the class and attributes it is given and passes the ref', async () => {
        const ref = createRef<HTMLSpanElement>();
        const host = await mount(
            <Tag className="mode" id="mode-tag" ref={ref}>
                Puzzle
            </Tag>,
        );
        const tag = host.querySelector('span#mode-tag');
        expect(tag?.className).toBe('pg-tag mode');
        expect(ref.current).toBe(tag);
    });
});
