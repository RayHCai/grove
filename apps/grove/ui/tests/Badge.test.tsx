import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { Badge } from '../src/components/Badge.js';
import { HeartIcon } from '../src/icons/HeartIcon.js';
import { LeafIcon } from '../src/icons/LeafIcon.js';
import { StarIcon } from '../src/icons/StarIcon.js';
import { mount } from './helpers.js';

describe('Badge', () => {
    it('is a span holding its text and no icon', async () => {
        const host = await mount(<Badge>Level 12</Badge>);
        const badge = host.firstElementChild;
        expect(badge?.tagName).toBe('SPAN');
        expect(badge?.className).toBe('pg-badge');
        expect(badge?.textContent).toBe('Level 12');
        expect(badge?.querySelector('svg')).toBeNull();
    });

    it('draws the chosen icon as a hidden 12px glyph before the text', async () => {
        const host = await mount(<Badge icon="star">Level 12</Badge>);
        const icon = host.querySelector('svg');
        expect(icon?.getAttribute('class')).toBe('pg-icon pg-badge__icon');
        expect(icon?.getAttribute('width')).toBe('12');
        expect(icon?.getAttribute('height')).toBe('12');
        expect(icon?.getAttribute('aria-hidden')).toBe('true');
        expect(icon?.previousSibling).toBeNull();
        expect(icon?.nextSibling?.textContent).toBe('Level 12');
    });

    it.each([
        ['sprout', LeafIcon],
        ['star', StarIcon],
        ['heart', HeartIcon],
    ] as const)('renders the %s icon as its glyph', async (icon, Glyph) => {
        const host = await mount(<Badge icon={icon}>Drop</Badge>);
        const glyph = await mount(<Glyph size={12} className="pg-badge__icon" />);
        expect(host.querySelector('svg')?.outerHTML).toBe(glyph.querySelector('svg')?.outerHTML);
    });

    it('keeps the class and attributes it is given and passes the ref', async () => {
        const ref = createRef<HTMLSpanElement>();
        const host = await mount(
            <Badge className="new" title="New" ref={ref}>
                New sprout
            </Badge>,
        );
        const badge = host.querySelector('span');
        expect(badge?.className).toBe('pg-badge new');
        expect(badge?.getAttribute('title')).toBe('New');
        expect(ref.current).toBe(badge);
    });
});
