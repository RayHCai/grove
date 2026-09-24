import { act, createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../src/components/Button.js';
import { PlayIcon } from '../src/icons/PlayIcon.js';
import { mount } from './helpers.js';

async function press(button: HTMLButtonElement | null): Promise<void> {
    await act(async () => {
        button?.click();
    });
}

describe('Button', () => {
    it('is a secondary, medium, type=button control with its text in the label slot', async () => {
        const host = await mount(<Button>Make a game</Button>);
        const button = host.querySelector('button');
        expect(button?.getAttribute('type')).toBe('button');
        expect(button?.className).toBe('pg-btn pg-btn--secondary');
        expect(button?.querySelector('.pg-btn__label')?.textContent).toBe('Make a game');
    });

    it('keeps the type, variant, size and class it is given', async () => {
        const host = await mount(
            <Button type="submit" variant="primary" size="sm" className="wide">
                Plant it
            </Button>,
        );
        const button = host.querySelector('button');
        expect(button?.getAttribute('type')).toBe('submit');
        expect(button?.className).toBe('pg-btn pg-btn--primary pg-btn--sm wide');
    });

    it('has a ghost variant', async () => {
        const host = await mount(<Button variant="ghost">Play</Button>);
        expect(host.querySelector('button')?.className).toBe('pg-btn pg-btn--ghost');
    });

    it('puts icons inside the label on either side of the text', async () => {
        const host = await mount(
            <Button icon={<PlayIcon />} iconEnd={<span data-end />}>
                Play
            </Button>,
        );
        const label = host.querySelector('.pg-btn__label');
        const icons = label?.querySelectorAll('.pg-btn__icon');
        expect(icons?.length).toBe(2);
        expect(icons?.[0]?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
        expect(icons?.[1]?.querySelector('[data-end]')).not.toBeNull();
        expect(label?.textContent).toBe('Play');
    });

    it('renders no icon slot when neither icon is given', async () => {
        const host = await mount(<Button>Plain</Button>);
        expect(host.querySelectorAll('.pg-btn__icon').length).toBe(0);
    });

    it('fires its click handler and hands the ref to the element', async () => {
        const onClick = vi.fn();
        const ref = createRef<HTMLButtonElement>();
        const host = await mount(
            <Button onClick={onClick} ref={ref}>
                Go
            </Button>,
        );
        const button = host.querySelector('button');
        await press(button);
        expect(onClick).toHaveBeenCalledOnce();
        expect(ref.current).toBe(button);
    });

    it('renders disabled as the native attribute', async () => {
        const host = await mount(<Button disabled>Locked</Button>);
        expect(host.querySelector('button')?.disabled).toBe(true);
    });

    it('keeps an aria-disabled button focusable but swallows its clicks', async () => {
        const onClick = vi.fn();
        const host = await mount(
            <Button aria-disabled="true" onClick={onClick}>
                Stop
            </Button>,
        );
        const button = host.querySelector('button');
        expect(button?.getAttribute('aria-disabled')).toBe('true');
        expect(button?.disabled).toBe(false);
        await press(button);
        expect(onClick).not.toHaveBeenCalled();
    });
});
