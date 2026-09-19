// The local run: the document a game is put in, and the channel the editor drives it over.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDocument, windowDocument } from '../src/run/document';
import { RunHost } from '../src/run/host';
import type { RunLine } from '../src/run/host';

const COLORS = { background: '#1b1916', foreground: '#e9e2d4' };

function documentOf(modules: Record<string, string>, entry = 'src/main.js'): string {
    return runDocument({ modules, entry, title: "Pip's Garden", ...COLORS });
}

/** What the frame's own script reads: the modules and the one to start at. */
function payloadOf(document: string): { modules: Record<string, string>; entry: string } {
    const found = /id="grove-run">(.*?)<\/script>/su.exec(document);
    if (found?.[1] === undefined) throw new Error('the run document carries no payload');
    return JSON.parse(found[1]) as { modules: Record<string, string>; entry: string };
}

describe('the run document', () => {
    it('carries every module and the one a run starts at', () => {
        const payload = payloadOf(
            documentOf({ 'src/main.js': 'import "./sprout.js";', 'src/sprout.js': 'export {};' }),
        );
        expect(Object.keys(payload.modules)).toEqual(['src/main.js', 'src/sprout.js']);
        expect(payload.entry).toBe('src/main.js');
    });

    it('carries the harness itself, because the frame can fetch nothing from this origin', () => {
        const document = documentOf({ 'src/main.js': '' });
        expect(document).toContain('grove-run');
        expect(document).toContain('createObjectURL');
        expect(document).not.toContain('<script src=');
    });

    it('cannot be closed out of from inside a creator’s own source', () => {
        const hostile = 'const sneak = "</script><script>parent.alert(1)</script>";';
        const document = documentOf({ 'src/main.js': hostile });

        // One script element holds the payload, and the creator's text never ends it.
        expect(document.match(/<script type="application\/json"/gu)).toHaveLength(1);
        expect(document).not.toContain('parent.alert(1)</script>');
        expect(payloadOf(document).modules['src/main.js']).toBe(hostile);
    });

    it('names the game and is painted on the theme the editor was wearing', () => {
        const document = documentOf({ 'src/main.js': '' });
        expect(document).toContain(String.raw`<title>Pip's Garden</title>`);
        expect(document).toContain('#1b1916');
    });
});

describe('the full-page document', () => {
    it('holds the same run in a sandboxed frame, and relays what it says to the opener', () => {
        const page = windowDocument(documentOf({ 'src/main.js': 'console.log(1)' }), 'Game');
        expect(page).toContain('sandbox="allow-scripts"');
        expect(page).toContain('srcdoc="');
        // The run's own markup is escaped into the attribute rather than parsed as this page's.
        expect(page).toContain('&lt;script');
        expect(page).toContain('window.opener.postMessage');
    });
});

describe('the run host', () => {
    let host: RunHost | undefined;
    const lines: RunLine[] = [];

    function open(): { host: RunHost; frame: HTMLIFrameElement } {
        const frame = document.createElement('iframe');
        document.body.append(frame);
        const opened = new RunHost({
            onLine: (line) => lines.push({ id: lines.length, ...line }),
        });
        opened.attach(frame);
        host = opened;
        return { host: opened, frame };
    }

    afterEach(() => {
        host?.dispose();
        host = undefined;
        lines.length = 0;
        vi.unstubAllGlobals();
    });

    it('puts the run in the frame it was attached to, and takes it away on stop', () => {
        const { host: run, frame } = open();
        run.start({ 'src/main.js': 'console.log(1)' }, 'src/main.js', 'Game', COLORS);
        expect(frame.getAttribute('srcdoc')).toContain('grove-run');

        run.stop();
        expect(frame.hasAttribute('srcdoc')).toBe(false);
    });

    it('prints what the run wrote, at the level it wrote it', () => {
        const { host: run, frame } = open();
        run.start({}, 'src/main.js', 'Game', COLORS);

        window.dispatchEvent(
            new MessageEvent('message', {
                source: frame.contentWindow,
                data: { source: 'grove-run', type: 'log', level: 'warn', text: 'careful' },
            }),
        );
        expect(lines).toEqual([{ id: 0, level: 'warn', text: 'careful' }]);
    });

    it('believes no window it did not open, whatever the message says it is', () => {
        const { host: run } = open();
        run.start({}, 'src/main.js', 'Game', COLORS);

        window.dispatchEvent(
            new MessageEvent('message', {
                source: window,
                data: { source: 'grove-run', type: 'error', text: 'from nowhere' },
            }),
        );
        expect(lines).toEqual([]);
    });

    it('holds and releases the run’s clock over the same channel', () => {
        const { host: run, frame } = open();
        run.start({}, 'src/main.js', 'Game', COLORS);
        const sent: unknown[] = [];
        vi.spyOn(frame.contentWindow as Window, 'postMessage').mockImplementation((message) => {
            sent.push(message);
        });

        run.pause();
        run.resume();
        expect(sent).toEqual([
            { source: 'grove-editor', type: 'pause' },
            { source: 'grove-editor', type: 'resume' },
        ]);
    });

    it('says so rather than failing quietly when a full-page run is blocked', () => {
        const { host: run } = open();
        vi.stubGlobal('open', () => null);
        run.start({}, 'src/main.js', 'Game', COLORS, 'window');

        expect(lines[0]?.level).toBe('error');
        expect(lines[0]?.text).toContain('pop-ups');
        // Falls back to the stage rather than leaving the run addressed at a window nobody opened.
        expect(run.surface).toBe('stage');
    });

    it('writes the full-page run into the window it opened', () => {
        const { host: run } = open();
        const written: string[] = [];
        const opened = {
            document: { write: (text: string) => written.push(text), close: vi.fn() },
            close: vi.fn(),
            postMessage: vi.fn(),
        };
        vi.stubGlobal('open', () => opened);

        run.start({ 'src/main.js': '' }, 'src/main.js', 'Game', COLORS, 'window');
        expect(run.surface).toBe('window');
        expect(written[0]).toContain('sandbox="allow-scripts"');
    });
});
