import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { Panel } from '../src/components/Panel.js';
import { mount } from './helpers.js';

describe('Panel', () => {
    it('is a div wearing the surface face by default', async () => {
        const host = await mount(<Panel>Hello</Panel>);
        const el = host.firstElementChild;
        expect(el?.tagName).toBe('DIV');
        expect(el?.className).toBe('pg-panel pg-panel--surface');
        expect(el?.textContent).toBe('Hello');
        expect(el?.childElementCount).toBe(0);
    });

    it.each(['accent', 'warm', 'olive'] as const)('wears the %s face', async (face) => {
        const host = await mount(<Panel face={face} />);
        expect(host.firstElementChild?.className).toBe(`pg-panel pg-panel--${face}`);
    });

    it('takes another element and face, keeps the class it is given, and passes the ref', async () => {
        const ref = createRef<HTMLDivElement>();
        const host = await mount(
            <Panel
                as="section"
                face="olive"
                className="foot"
                id="p"
                ref={ref}
                aria-label="Footer"
            />,
        );
        const el = host.querySelector('section#p');
        expect(el?.className).toBe('pg-panel pg-panel--olive foot');
        expect(el?.getAttribute('aria-label')).toBe('Footer');
        expect(ref.current).toBe(el);
    });
});
