import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { Tilestrip } from '../src/components/Tilestrip.js';
import { mount } from './helpers.js';

describe('Tilestrip', () => {
    it('is an empty div hidden from assistive technology', async () => {
        const host = await mount(<Tilestrip />);
        const el = host.firstElementChild;
        expect(el?.tagName).toBe('DIV');
        expect(el?.className).toBe('pg-tilestrip');
        expect(el?.getAttribute('aria-hidden')).toBe('true');
        expect(el?.childNodes.length).toBe(0);
    });

    it('keeps the class and attributes it is given and passes the ref', async () => {
        const ref = createRef<HTMLDivElement>();
        const host = await mount(<Tilestrip className="top" id="strip" ref={ref} />);
        const el = host.querySelector('div#strip');
        expect(el?.className).toBe('pg-tilestrip top');
        expect(ref.current).toBe(el);
    });
});
