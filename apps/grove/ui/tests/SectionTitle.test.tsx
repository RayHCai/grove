import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { SectionTitle } from '../src/components/SectionTitle.js';
import { mount } from './helpers.js';

describe('SectionTitle', () => {
    it('is an h2 and nothing else', async () => {
        const host = await mount(<SectionTitle>Featured worlds</SectionTitle>);
        expect(host.children.length).toBe(1);
        const heading = host.firstElementChild;
        expect(heading?.tagName).toBe('H2');
        expect(heading?.className).toBe('pg-sectitle');
        expect(heading?.textContent).toBe('Featured worlds');
    });

    it('takes another heading level, keeps its id and class, and passes the ref', async () => {
        const ref = createRef<HTMLHeadingElement>();
        const host = await mount(
            <SectionTitle as="h1" id="worlds-title" className="rise" ref={ref}>
                Featured worlds
            </SectionTitle>,
        );
        const heading = host.querySelector('h1#worlds-title');
        expect(heading?.className).toBe('pg-sectitle rise');
        expect(ref.current).toBe(heading);
    });

    it('puts the subline in a muted paragraph after the heading, outside its name', async () => {
        const host = await mount(
            <SectionTitle subline="Fresh from the community garden.">Featured worlds</SectionTitle>,
        );
        const heading = host.querySelector('h2');
        expect(heading?.textContent).toBe('Featured worlds');
        const sub = heading?.nextElementSibling;
        expect(sub?.tagName).toBe('P');
        expect(sub?.className).toBe('pg-sectitle__sub');
        expect(sub?.textContent).toBe('Fresh from the community garden.');
    });
});
