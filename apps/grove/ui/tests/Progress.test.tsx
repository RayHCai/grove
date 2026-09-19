import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { Progress } from '../src/components/Progress.js';
import { mount } from './helpers.js';

function scale(fill: HTMLElement | null): number {
    const match = /^scaleX\((.+)\)$/.exec(fill?.style.transform ?? '');
    return Number.parseFloat(match?.[1] ?? '');
}

describe('Progress', () => {
    it('is a progressbar named by its label, showing the value as a percentage and a fill scaled to it', async () => {
        const host = await mount(<Progress label="Garden level 7" value={64} />);
        const bar = host.querySelector('[role="progressbar"]');
        const label = host.querySelector('.pg-progress__label');
        expect(host.firstElementChild?.className).toBe('pg-progress');
        expect(label?.textContent).toBe('Garden level 7');
        expect(label?.id).not.toBe('');
        expect(bar?.className).toBe('pg-progress__bar');
        expect(bar?.getAttribute('aria-labelledby')).toBe(label?.id);
        expect(bar?.getAttribute('aria-valuemin')).toBe('0');
        expect(bar?.getAttribute('aria-valuemax')).toBe('100');
        expect(bar?.getAttribute('aria-valuenow')).toBe('64');
        expect(host.querySelector('.pg-progress__value')?.textContent).toBe('64%');
        expect(host.querySelector<HTMLElement>('.pg-progress__fill')?.style.transform).toBe(
            'scaleX(0.64)',
        );
    });

    it('scales the percentage and the fill to the max it is given', async () => {
        const host = await mount(<Progress label="Seeds" value={1} max={3} />);
        const bar = host.querySelector('[role="progressbar"]');
        const fill = host.querySelector<HTMLElement>('.pg-progress__fill');
        expect(bar?.getAttribute('aria-valuemax')).toBe('3');
        expect(bar?.getAttribute('aria-valuenow')).toBe('1');
        expect(host.querySelector('.pg-progress__value')?.textContent).toBe('33%');
        expect(scale(fill)).toBeCloseTo(1 / 3);
    });

    it('clamps a value outside the range', async () => {
        const host = await mount(
            <>
                <Progress label="Over" value={140} />
                <Progress label="Under" value={-5} />
            </>,
        );
        const bars = host.querySelectorAll('[role="progressbar"]');
        const fills = host.querySelectorAll<HTMLElement>('.pg-progress__fill');
        const values = host.querySelectorAll('.pg-progress__value');
        expect(bars[0]?.getAttribute('aria-valuenow')).toBe('100');
        expect(fills[0]?.style.transform).toBe('scaleX(1)');
        expect(values[0]?.textContent).toBe('100%');
        expect(bars[1]?.getAttribute('aria-valuenow')).toBe('0');
        expect(fills[1]?.style.transform).toBe('scaleX(0)');
        expect(values[1]?.textContent).toBe('0%');
    });

    it('sets no width on the fill, so the track alone decides how wide a full bar is', async () => {
        const host = await mount(<Progress label="XP" value={50} />);
        const fill = host.querySelector<HTMLElement>('.pg-progress__fill');
        expect(fill?.style.width).toBe('');
        expect(fill?.getAttribute('style')).toBe('transform: scaleX(0.5);');
    });

    it('keeps the class it is given and passes the ref and native attributes to the root', async () => {
        const ref = createRef<HTMLDivElement>();
        const host = await mount(
            <Progress label="XP" value={10} id="xp" className="wide" title="Ten" ref={ref} />,
        );
        const root = host.querySelector('#xp');
        expect(root?.className).toBe('pg-progress wide');
        expect(root?.getAttribute('title')).toBe('Ten');
        expect(ref.current).toBe(root);
    });
});
