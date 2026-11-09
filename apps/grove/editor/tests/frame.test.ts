// The run's document end of the channel: what it tells the editor, and what it believes from it.

import { describe, expect, it, vi } from 'vitest';
import { gateClocks } from '../src/preview/clock';
import { openStage } from '../src/preview/frame';
import type { Stage } from '../src/preview/frame';
import { LinkError } from '../src/preview/link';
import { serve } from '../src/preview/stage';
import { CHANNEL } from '../src/run/protocol';
import type { Game } from '../src/run/protocol';

const RUN = '0f0e3c1a-run';

const GAME: Game = {
    mode: 'plain',
    modules: { 'src/main.js': '' },
    entry: 'src/main.js',
    title: 'Game',
    colors: { background: '#000', foreground: '#fff' },
};

/** A window the stage opens on: the editor as its parent, and the listeners it registered. */
function scope() {
    const parent = { postMessage: vi.fn() };
    const listeners = new Map<string, (event: unknown) => void>();
    const window = {
        location: { href: `https://editor.grove.example/preview-plain.html?run=${RUN}` },
        parent,
        addEventListener: (type: string, listener: (event: unknown) => void) => {
            listeners.set(type, listener);
        },
    };
    const said = (): unknown[] => parent.postMessage.mock.calls.map(([message]) => message);
    const from = (data: Record<string, unknown>, source: unknown = parent): void => {
        listeners.get('message')?.({ source, data: { channel: CHANNEL, run: RUN, ...data } });
    };
    return { window: window as unknown as Window, said, from, listeners };
}

describe('the run’s document', () => {
    it('says it is ready, under the run it was opened for, before anything else', () => {
        const held = scope();
        openStage(async () => undefined, held.window);

        expect(held.said()).toEqual([{ type: 'ready', channel: CHANNEL, run: RUN }]);
    });

    it('starts the first run the editor hands it, and no second one', async () => {
        const held = scope();
        const start = vi.fn(async (_game: Game) => undefined);
        openStage(start, held.window);

        held.from({ type: 'run', game: GAME });
        held.from({ type: 'run', game: GAME });
        await Promise.resolve();

        expect(start).toHaveBeenCalledTimes(1);
        expect(start.mock.calls[0]?.[0]).toEqual(GAME);
        expect(held.said()).toContainEqual({
            type: 'status',
            status: 'starting',
            channel: CHANNEL,
            run: RUN,
        });
    });

    it('believes nothing but its parent, the run’s own code posting to itself included', () => {
        const held = scope();
        const start = vi.fn(async () => undefined);
        openStage(start, held.window);

        held.from({ type: 'run', game: GAME }, held.window);
        held.from({ type: 'run', game: GAME, run: 'another-run' });
        expect(start).not.toHaveBeenCalled();
    });

    it('reaches the run’s clock with pause and resume once there is one', async () => {
        const held = scope();
        const turned: string[] = [];
        openStage(async (_game, stage) => {
            stage.controls({
                pause: () => turned.push('pause'),
                resume: () => turned.push('resume'),
            });
        }, held.window);
        held.from({ type: 'run', game: GAME });
        await Promise.resolve();

        held.from({ type: 'pause' });
        held.from({ type: 'resume' });
        expect(turned).toEqual(['pause', 'resume']);
    });

    it('says why a run failed, a link error in its own words', async () => {
        const held = scope();
        openStage(async () => {
            throw new LinkError('src/a.js imports ./b, and nothing in this game is there');
        }, held.window);
        held.from({ type: 'run', game: GAME });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(held.said()).toContainEqual({
            type: 'line',
            level: 'error',
            text: 'src/a.js imports ./b, and nothing in this game is there',
            channel: CHANNEL,
            run: RUN,
        });
        expect(held.said().at(-1)).toEqual({
            type: 'status',
            status: 'failed',
            channel: CHANNEL,
            run: RUN,
        });
    });

    it('hands the run a console that prints every argument as the pane reads it', async () => {
        const held = scope();
        let stage: Stage | undefined;
        openStage(async (_game, opened) => {
            stage = opened;
        }, held.window);
        held.from({ type: 'run', game: GAME });
        await Promise.resolve();

        stage?.console.warn('pip is', 3, { tall: true });
        expect(held.said().at(-1)).toEqual({
            type: 'line',
            level: 'warn',
            text: 'pip is 3 {tall: true}',
            channel: CHANNEL,
            run: RUN,
        });
    });
});

describe('the clock of a plain run', () => {
    it('holds every frame and timer asked for while paused, and hands them over on resume', () => {
        const queued: (() => void)[] = [];
        const schedule = (callback: () => void): number => {
            queued.push(callback);
            return queued.length;
        };
        const window = {
            requestAnimationFrame: schedule,
            setTimeout: schedule,
            setInterval: schedule,
        } as unknown as Window;
        const clock = gateClocks(window);
        const fired: string[] = [];

        window.requestAnimationFrame(() => fired.push('frame'));
        window.setTimeout(() => fired.push('timer'), 10);
        clock.pause();
        for (const callback of queued.splice(0)) callback();
        expect(fired).toEqual([]);

        clock.resume();
        expect(fired).toEqual(['frame', 'timer']);
    });
});

describe('the editor’s files a world names', () => {
    it('are answered from the bytes handed over, and anything else goes to the network', async () => {
        const network = vi.fn(async () => new Response('from the network'));
        const window = { fetch: network } as unknown as typeof globalThis;
        serve(
            [
                {
                    url: new URL('/avatar-square.svg', document.baseURI).href,
                    contentType: 'image/svg+xml',
                    bytes: new TextEncoder().encode('<svg/>').buffer,
                },
            ],
            window,
        );

        const art = await window.fetch('/avatar-square.svg');
        expect(art.headers.get('content-type')).toBe('image/svg+xml');
        expect(await art.text()).toBe('<svg/>');
        // A body is spent once read, so a second load of the same art gets bytes of its own.
        expect(await (await window.fetch('/avatar-square.svg')).text()).toBe('<svg/>');

        await window.fetch('https://cdn.example/other.png');
        expect(network).toHaveBeenCalledTimes(1);
    });
});
