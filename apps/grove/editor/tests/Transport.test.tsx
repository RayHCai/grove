import { act, useReducer } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Transport, transportReducer } from '../src/shell/Transport';
import { mount } from './helpers';

function Harness(): React.JSX.Element {
    const [state, dispatch] = useReducer(transportReducer, 'idle');
    return (
        <>
            <Transport state={state} dispatch={dispatch} />
            <output>{state}</output>
        </>
    );
}

async function press(button: HTMLButtonElement | null | undefined): Promise<void> {
    await act(async () => {
        button?.focus();
        button?.click();
    });
}

describe('transportReducer', () => {
    it.each([
        { from: 'idle', action: 'play', to: 'playing' },
        { from: 'playing', action: 'pause', to: 'paused' },
        { from: 'paused', action: 'play', to: 'playing' },
        { from: 'playing', action: 'stop', to: 'idle' },
        { from: 'paused', action: 'stop', to: 'idle' },
        { from: 'idle', action: 'pause', to: 'idle' },
        { from: 'idle', action: 'stop', to: 'idle' },
        { from: 'playing', action: 'play', to: 'playing' },
        { from: 'paused', action: 'pause', to: 'paused' },
    ] as const)('moves $from to $to on $action', ({ from, action, to }) => {
        expect(transportReducer(from, action)).toBe(to);
    });
});

describe('Transport', () => {
    it('is a group of run controls: a primary Play and a ghost Stop', async () => {
        const host = await mount(<Transport state="idle" dispatch={vi.fn()} />);
        const group = host.querySelector('[role="group"]');
        expect(group?.getAttribute('aria-label')).toBe('Run controls');
        const buttons = group?.querySelectorAll('button');
        expect(buttons?.length).toBe(2);
        expect(buttons?.[0]?.className).toBe('pg-btn pg-btn--primary pg-btn--sm transport__play');
        expect(buttons?.[0]?.textContent).toBe('Play');
        expect(buttons?.[0]?.hasAttribute('aria-pressed')).toBe(false);
        expect(buttons?.[1]?.getAttribute('aria-label')).toBe('Stop');
        expect(buttons?.[1]?.className).toBe('pg-iconbtn pg-iconbtn--ghost pg-iconbtn--sm');
    });

    it('keeps Stop focusable but inert while idle', async () => {
        const dispatch = vi.fn();
        const host = await mount(<Transport state="idle" dispatch={dispatch} />);
        const stop = host.querySelector<HTMLButtonElement>('[aria-label="Stop"]');
        expect(stop?.getAttribute('aria-disabled')).toBe('true');
        expect(stop?.disabled).toBe(false);
        await press(stop);
        expect(dispatch).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(stop);
    });

    it.each([
        { state: 'playing', label: 'Pause', stopInert: false },
        { state: 'paused', label: 'Play', stopInert: false },
        { state: 'idle', label: 'Play', stopInert: true },
    ] as const)('labels the primary $label while $state', async ({ state, label, stopInert }) => {
        const host = await mount(<Transport state={state} dispatch={vi.fn()} />);
        expect(host.querySelector('.transport__play')?.textContent).toBe(label);
        expect(host.querySelector('[aria-label="Stop"]')?.getAttribute('aria-disabled')).toBe(
            stopInert ? 'true' : null,
        );
    });

    it('walks play, pause, play, stop without ever dropping focus off a control', async () => {
        const host = await mount(<Harness />);
        const group = host.querySelector('[role="group"]');
        const primary = host.querySelector<HTMLButtonElement>('.transport__play');
        const stop = host.querySelector<HTMLButtonElement>('[aria-label="Stop"]');
        const state = (): string | undefined => host.querySelector('output')?.textContent;

        await press(primary);
        expect(state()).toBe('playing');
        expect(primary?.textContent).toBe('Pause');
        expect(group?.contains(document.activeElement)).toBe(true);

        await press(primary);
        expect(state()).toBe('paused');
        expect(primary?.textContent).toBe('Play');
        expect(document.activeElement).toBe(primary);

        await press(primary);
        expect(state()).toBe('playing');
        expect(document.activeElement).toBe(primary);

        await press(stop);
        expect(state()).toBe('idle');
        expect(stop?.getAttribute('aria-disabled')).toBe('true');
        expect(document.activeElement).toBe(stop);
        expect(host.querySelector('.transport__play')).toBe(primary);
    });
});
