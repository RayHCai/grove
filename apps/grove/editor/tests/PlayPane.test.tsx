import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { MaximizeIcon, MinimizeIcon } from '@grove/ui';
import { PlayPane } from '../src/player/PlayPane';
import { mount } from './helpers';

const restores: Array<() => void> = [];

function override(target: object, key: string, descriptor: PropertyDescriptor): void {
    const original = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
    restores.push(() => {
        if (original === undefined) {
            Reflect.deleteProperty(target, key);
        } else {
            Object.defineProperty(target, key, original);
        }
    });
}

interface FullscreenStub {
    request: Mock<() => Promise<void>>;
    exit: Mock<() => Promise<void>>;
    enter: (element: Element | null) => void;
}

/** jsdom has no Fullscreen API; this installs one whose fullscreen element the test moves by hand. */
function stubFullscreen(): FullscreenStub {
    let element: Element | null = null;
    const request = vi.fn(() => Promise.resolve());
    const exit = vi.fn(() => Promise.resolve());
    override(HTMLElement.prototype, 'requestFullscreen', { writable: true, value: request });
    override(document, 'exitFullscreen', { writable: true, value: exit });
    override(document, 'fullscreenElement', { get: () => element });
    return {
        request,
        exit,
        enter: (next) => {
            element = next;
        },
    };
}

async function click(button: HTMLElement | null | undefined): Promise<void> {
    await act(async () => {
        button?.click();
    });
}

async function changeFullscreen(target: EventTarget | null | undefined): Promise<void> {
    await act(async () => {
        target?.dispatchEvent(new Event('fullscreenchange', { bubbles: true }));
    });
}

function fullscreenButton(host: HTMLElement): HTMLButtonElement | null {
    return host.querySelector<HTMLButtonElement>('.play-fullscreen');
}

afterEach(() => {
    for (const restore of restores.splice(0).toReversed()) restore();
});

describe('PlayPane', () => {
    it('is a section named by a hidden Play heading that opens the header', async () => {
        const host = await mount(<PlayPane status="idle" dispatch={vi.fn()} />);
        const section = host.querySelector('section');
        expect(section?.getAttribute('aria-labelledby')).toBe('play-title');
        const heading = section?.querySelector('h2#play-title');
        expect(heading?.textContent).toBe('Play');
        expect(heading?.className).toBe('pg-visually-hidden');
        const header = section?.querySelector('.pane__header');
        expect(header?.firstElementChild).toBe(heading);
    });

    it('is a play pane panel of a header and a stage and keeps the class it is given', async () => {
        const host = await mount(<PlayPane status="idle" dispatch={vi.fn()} className="side" />);
        const section = host.querySelector('section');
        expect(section?.className).toBe('pg-panel pg-panel--surface pane pane--play side');
        expect(section?.children.length).toBe(2);
        expect(section?.children[0]?.className).toBe('pane__header');
        expect(section?.children[1]?.className).toBe('play-stage');
    });

    it('puts the transport in the header and forwards its actions', async () => {
        const dispatch = vi.fn();
        const host = await mount(<PlayPane status="idle" dispatch={dispatch} />);
        const group = host.querySelector('.pane__header [role="group"]');
        expect(group?.getAttribute('aria-label')).toBe('Run controls');
        const primary = group?.querySelector<HTMLButtonElement>('.transport__play');
        expect(primary?.textContent).toBe('Play');
        const stop = group?.querySelector<HTMLButtonElement>('[aria-label="Stop"]');
        expect(stop?.getAttribute('aria-disabled')).toBe('true');

        await click(primary);
        expect(dispatch).toHaveBeenCalledWith('play');
        await click(stop);
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it.each([
        { status: 'idle', text: 'Idle', primary: 'Play' },
        { status: 'playing', text: 'Running', primary: 'Pause' },
        { status: 'paused', text: 'Paused', primary: 'Play' },
    ] as const)(
        'announces $text at the header end while $status',
        async ({ status, text, primary }) => {
            const host = await mount(<PlayPane status={status} dispatch={vi.fn()} />);
            const chip = host.querySelector('[role="status"]');
            expect(chip?.textContent).toBe(text);
            expect(chip?.className).toBe(`play-status play-status--${status}`);
            const header = host.querySelector('.pane__header');
            expect(header?.lastElementChild).toBe(chip);
            expect(host.querySelector('.transport__play')?.textContent).toBe(primary);
        },
    );

    it('shows the game in a sandboxed frame with no source that is not a tab stop', async () => {
        const host = await mount(<PlayPane status="idle" dispatch={vi.fn()} />);
        const stage = host.querySelector('.play-stage');
        const frame = stage?.querySelector('iframe');
        expect(frame?.getAttribute('title')).toBe('Game preview');
        expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
        expect(frame?.tabIndex).toBe(-1);
        expect(frame?.hasAttribute('src')).toBe(false);
        expect(frame?.className).toBe('play-frame');
        expect(stage?.firstElementChild).toBe(frame);
    });

    it('floats a small secondary fullscreen button after the frame', async () => {
        const host = await mount(<PlayPane status="idle" dispatch={vi.fn()} />);
        const button = fullscreenButton(host);
        expect(button?.className).toBe(
            'pg-iconbtn pg-iconbtn--secondary pg-iconbtn--sm play-fullscreen',
        );
        expect(button?.getAttribute('aria-label')).toBe('Enter fullscreen');
        expect(button?.getAttribute('title')).toBe('Enter fullscreen');
        expect(host.querySelector('iframe')?.nextElementSibling).toBe(button);
        const reference = await mount(<MaximizeIcon />);
        expect(button?.querySelector('svg')?.outerHTML).toBe(
            reference.querySelector('svg')?.outerHTML,
        );
    });

    it('asks the stage for fullscreen and flips the label once the document reports it', async () => {
        const fullscreen = stubFullscreen();
        const host = await mount(<PlayPane status="idle" dispatch={vi.fn()} />);
        const stage = host.querySelector<HTMLDivElement>('.play-stage');
        const button = fullscreenButton(host);

        await click(button);
        expect(fullscreen.request).toHaveBeenCalledTimes(1);
        expect(fullscreen.request.mock.contexts[0]).toBe(stage);
        expect(button?.getAttribute('aria-label')).toBe('Enter fullscreen');

        fullscreen.enter(stage);
        await changeFullscreen(stage);
        expect(button?.getAttribute('aria-label')).toBe('Exit fullscreen');
        expect(button?.getAttribute('title')).toBe('Exit fullscreen');
        const reference = await mount(<MinimizeIcon />);
        expect(button?.querySelector('svg')?.outerHTML).toBe(
            reference.querySelector('svg')?.outerHTML,
        );

        await click(button);
        expect(fullscreen.exit).toHaveBeenCalledTimes(1);
        expect(fullscreen.request).toHaveBeenCalledTimes(1);

        fullscreen.enter(null);
        await changeFullscreen(stage);
        expect(button?.getAttribute('aria-label')).toBe('Enter fullscreen');
    });

    it('stays out of fullscreen while another element holds it', async () => {
        const fullscreen = stubFullscreen();
        const host = await mount(<PlayPane status="idle" dispatch={vi.fn()} />);
        fullscreen.enter(document.body);
        await changeFullscreen(document.body);
        expect(fullscreenButton(host)?.getAttribute('aria-label')).toBe('Enter fullscreen');
    });

    it('does nothing where the Fullscreen API is missing', async () => {
        const host = await mount(<PlayPane status="idle" dispatch={vi.fn()} />);
        const button = fullscreenButton(host);
        await click(button);
        expect(button?.getAttribute('aria-label')).toBe('Enter fullscreen');
    });

    it('swallows a rejected request or exit instead of leaving it unhandled', async () => {
        const fullscreen = stubFullscreen();
        fullscreen.request.mockImplementationOnce(() => Promise.reject(new Error('no activation')));
        fullscreen.exit.mockImplementationOnce(() => Promise.reject(new Error('not fullscreen')));
        const host = await mount(<PlayPane status="idle" dispatch={vi.fn()} />);
        const stage = host.querySelector<HTMLDivElement>('.play-stage');
        const button = fullscreenButton(host);

        await click(button);
        expect(fullscreen.request).toHaveBeenCalledTimes(1);

        fullscreen.enter(stage);
        await changeFullscreen(stage);
        await click(button);
        expect(fullscreen.exit).toHaveBeenCalledTimes(1);
        expect(button?.getAttribute('aria-label')).toBe('Exit fullscreen');
    });
});
