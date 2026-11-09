// The editor's end of a run: the document it opens, what it hands that document, and what it believes.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_FORMAT_VERSION } from '@platform/project';
import { PreviewHost } from '../src/run/host';
import type { Game, LogLevel, StageStatus } from '../src/run/protocol';
import { CHANNEL } from '../src/run/protocol';

const DOCUMENTS = { plain: '/preview-plain.html', world: '/preview-world.html' };

const PLAIN: Game = {
    mode: 'plain',
    modules: { 'src/main.js': 'console.log(1);' },
    entry: 'src/main.js',
    title: "Pip's Garden",
    colors: { background: '#1b1916', foreground: '#e9e2d4' },
};

const WORLD: Game = {
    mode: 'world',
    modules: { 'src/player.js': 'export class Rules {}' },
    project: {
        formatVersion: PROJECT_FORMAT_VERSION,
        projectId: 'a-game',
        contentHash: 'a-hash',
        settings: {
            simRate: 30,
            sendRate: 15,
            maxPlayers: 4,
            bounds: { left: -480, right: 480, top: 270, bottom: -270 },
            regions: [],
        },
        assets: [],
        scriptModules: [],
        templates: [],
        entities: [],
        gameScripts: [],
    },
    name: 'Rowan',
    colors: { background: '#1b1916', foreground: '#e9e2d4' },
    assets: [],
};

let opened: PreviewHost | undefined;

afterEach(() => {
    opened?.dispose();
    opened = undefined;
});

function open(): {
    host: PreviewHost;
    frame: HTMLIFrameElement;
    lines: [LogLevel, string][];
    statuses: StageStatus[];
} {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const lines: [LogLevel, string][] = [];
    const statuses: StageStatus[] = [];
    const host = new PreviewHost(
        {
            onLine: (level, text) => lines.push([level, text]),
            onStatus: (status) => statuses.push(status),
        },
        DOCUMENTS,
    );
    host.attach(frame);
    opened = host;
    return { host, frame, lines, statuses };
}

/** What the host posts to the document the frame holds now, which a new src replaces. */
function posts(frame: HTMLIFrameElement): unknown[] {
    const posted: unknown[] = [];
    vi.spyOn(frame.contentWindow as Window, 'postMessage').mockImplementation((message) => {
        posted.push(message);
    });
    return posted;
}

function runOf(frame: HTMLIFrameElement): string {
    return new URL(frame.src).searchParams.get('run') ?? '';
}

/** A message as the run's document would send it, from the window the frame holds. */
function fromFrame(
    frame: HTMLIFrameElement,
    data: Record<string, unknown>,
    source?: unknown,
): void {
    window.dispatchEvent(
        new MessageEvent('message', {
            source: (source ?? frame.contentWindow) as Window,
            data: { channel: CHANNEL, run: runOf(frame), ...data },
        }),
    );
}

describe('starting a run', () => {
    it('opens the document for its kind of game, fresh, under a run of its own', () => {
        const { host, frame } = open();

        host.start(PLAIN);
        const first = new URL(frame.src);
        expect(first.pathname).toBe('/preview-plain.html');
        expect(runOf(frame)).not.toBe('');

        host.start(WORLD);
        expect(new URL(frame.src).pathname).toBe('/preview-world.html');
        // A query rather than a fragment: a fragment alone would scroll the old document.
        expect(runOf(frame)).not.toBe(first.searchParams.get('run'));
    });

    it('hands the game over only once its document says it is listening, and only once', () => {
        const { host, frame } = open();
        host.start(WORLD);
        const posted = posts(frame);
        expect(posted).toEqual([]);

        fromFrame(frame, { type: 'ready' });
        fromFrame(frame, { type: 'ready' });
        expect(posted).toEqual([{ type: 'run', game: WORLD, channel: CHANNEL, run: runOf(frame) }]);
    });

    it('drops the document on stop, which is what ends the run', () => {
        const { host, frame } = open();
        host.start(PLAIN);
        host.stop();
        expect(frame.src).toBe('about:blank');
    });
});

describe('what a run says', () => {
    it('prints a line at the level it was written at, and passes on where the stage got to', () => {
        const { host, frame, lines, statuses } = open();
        host.start(PLAIN);

        fromFrame(frame, { type: 'line', level: 'warn', text: 'careful' });
        fromFrame(frame, { type: 'line', level: 'shout', text: 'unknown levels are plain logs' });
        fromFrame(frame, { type: 'status', status: 'running' });

        expect(lines).toEqual([
            ['warn', 'careful'],
            ['log', 'unknown levels are plain logs'],
        ]);
        expect(statuses).toEqual(['running']);
    });

    it('is believed from no window but the frame it filled, whatever it says it is', () => {
        const { host, frame, lines } = open();
        host.start(PLAIN);

        fromFrame(frame, { type: 'line', level: 'error', text: 'from this page' }, window);
        expect(lines).toEqual([]);
    });

    it('is believed only for the run on stage, not one a frame was sent away from', () => {
        const { host, frame, lines } = open();
        host.start(PLAIN);
        const stale = runOf(frame);
        host.start(PLAIN);

        window.dispatchEvent(
            new MessageEvent('message', {
                source: frame.contentWindow as Window,
                data: { channel: CHANNEL, run: stale, type: 'line', level: 'log', text: 'late' },
            }),
        );
        expect(lines).toEqual([]);
    });
});

describe('the transport', () => {
    it('holds and releases the run’s clock over the same channel', () => {
        const { host, frame } = open();
        host.start(PLAIN);
        const posted = posts(frame);

        host.pause();
        host.resume();
        expect(posted).toEqual([
            { type: 'pause', channel: CHANNEL, run: runOf(frame) },
            { type: 'resume', channel: CHANNEL, run: runOf(frame) },
        ]);
    });

    it('sends nothing once the run is stopped', () => {
        const { host, frame } = open();
        host.start(PLAIN);
        host.stop();
        const posted = posts(frame);

        host.pause();
        expect(posted).toEqual([]);
    });
});
