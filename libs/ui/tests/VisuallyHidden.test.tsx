import { describe, expect, it } from 'vitest';
import { VisuallyHidden } from '../src/components/VisuallyHidden.js';
import { mount } from './helpers.js';

describe('VisuallyHidden', () => {
    it('is a span carrying the hidden class', async () => {
        const host = await mount(<VisuallyHidden>Player</VisuallyHidden>);
        const el = host.firstElementChild;
        expect(el?.tagName).toBe('SPAN');
        expect(el?.className).toBe('pg-visually-hidden');
        expect(el?.textContent).toBe('Player');
    });

    it('renders as the element it is asked for', async () => {
        const host = await mount(
            <VisuallyHidden as="p" id="keys" className="extra">
                Press Ctrl+M
            </VisuallyHidden>,
        );
        const el = host.querySelector('p#keys');
        expect(el?.className).toBe('pg-visually-hidden extra');
    });
});
