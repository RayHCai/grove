import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { Eyebrow } from '../src/components/Eyebrow.js';
import { mount } from './helpers.js';

describe('Eyebrow', () => {
    it('is a paragraph with the eyebrow class and its text', async () => {
        const host = await mount(<Eyebrow>A place to grow</Eyebrow>);
        const eyebrow = host.firstElementChild;
        expect(eyebrow?.tagName).toBe('P');
        expect(eyebrow?.className).toBe('pg-eyebrow');
        expect(eyebrow?.textContent).toBe('A place to grow');
    });

    it('can be a span, keeps the class it is given and passes the ref', async () => {
        const ref = createRef<HTMLParagraphElement>();
        const host = await mount(
            <Eyebrow as="span" className="rise" ref={ref}>
                Featured
            </Eyebrow>,
        );
        const eyebrow = host.querySelector('span');
        expect(eyebrow?.className).toBe('pg-eyebrow rise');
        expect(ref.current).toBe(eyebrow);
    });
});
