import { act, createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Toggle } from '../src/components/Toggle.js';
import { mount } from './helpers.js';

async function press(button: HTMLButtonElement | null): Promise<void> {
    await act(async () => {
        button?.click();
    });
}

describe('Toggle', () => {
    it('is a type=button switch named by its label, with its state in aria-pressed', async () => {
        const host = await mount(<Toggle label="Garden sounds" pressed />);
        const button = host.querySelector('button');
        expect(button?.getAttribute('type')).toBe('button');
        expect(button?.className).toBe('pg-toggle');
        expect(button?.getAttribute('aria-pressed')).toBe('true');
        expect(button?.querySelector('.pg-toggle__label')?.textContent).toBe('Garden sounds');
        const track = button?.querySelector('.pg-toggle__track');
        expect(track?.getAttribute('aria-hidden')).toBe('true');
        expect(track?.textContent).toBe('');
        expect(track?.querySelector('.pg-toggle__knob')).not.toBeNull();
    });

    it('hides ON or OFF after the label unless given other words', async () => {
        const host = await mount(<Toggle label="Music" pressed={false} />);
        const state = host.querySelector('.pg-toggle__state');
        expect(state?.className).toBe('pg-visually-hidden pg-toggle__state');
        expect(state?.previousElementSibling?.className).toBe('pg-toggle__label');
        expect(state?.textContent).toBe('OFF');
        const on = await mount(<Toggle label="Music" pressed />);
        expect(on.querySelector('.pg-toggle__state')?.textContent).toBe('ON');
        const custom = await mount(<Toggle label="Music" pressed onLabel="YES" offLabel="NO" />);
        expect(custom.querySelector('.pg-toggle__state')?.textContent).toBe('YES');
        const customOff = await mount(
            <Toggle label="Music" pressed={false} onLabel="YES" offLabel="NO" />,
        );
        expect(customOff.querySelector('.pg-toggle__state')?.textContent).toBe('NO');
    });

    it('asks for the opposite state on click and hands the ref to the button', async () => {
        const onChange = vi.fn();
        const ref = createRef<HTMLButtonElement>();
        const host = await mount(
            <Toggle label="Music" pressed onChange={onChange} ref={ref} className="wide" />,
        );
        const button = host.querySelector('button');
        expect(button?.className).toBe('pg-toggle wide');
        await press(button);
        expect(onChange).toHaveBeenCalledExactlyOnceWith(false);
        expect(ref.current).toBe(button);
    });

    it('lets a click handler that prevents default keep the state', async () => {
        const onChange = vi.fn();
        const onClick = vi.fn((event: React.MouseEvent<HTMLButtonElement>) => {
            event.preventDefault();
        });
        const host = await mount(
            <Toggle label="Music" pressed={false} onChange={onChange} onClick={onClick} />,
        );
        await press(host.querySelector('button'));
        expect(onClick).toHaveBeenCalledOnce();
        expect(onChange).not.toHaveBeenCalled();
    });

    it('keeps an aria-disabled toggle focusable but swallows its clicks', async () => {
        const onChange = vi.fn();
        const host = await mount(
            <Toggle label="Music" pressed aria-disabled="true" onChange={onChange} />,
        );
        const button = host.querySelector('button');
        expect(button?.disabled).toBe(false);
        await press(button);
        expect(onChange).not.toHaveBeenCalled();
    });
});
