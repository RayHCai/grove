import { Profiler, act } from 'react';
import { describe, expect, it } from 'vitest';
import { TerminalIcon } from '@grove/ui';
import { mount } from '@grove/ui/testing';
import { ConsolePane } from '../src/console/ConsolePane';
import { ConsoleLines, MAX_LINES } from '../src/console/lines';

/** A console whose frames the case turns by hand, so what one frame draws is what is asserted. */
function frames(): { lines: ConsoleLines; flush: () => Promise<void>; due: () => number } {
    let waiting: (() => void)[] = [];
    const lines = new ConsoleLines((flush) => waiting.push(flush));
    return {
        lines,
        due: () => waiting.length,
        flush: async () => {
            await act(async () => {
                const run = waiting;
                waiting = [];
                for (const flush of run) flush();
            });
        },
    };
}

function written(): ReturnType<typeof frames> {
    const held = frames();
    held.lines.write('log', 'day 1: Pip is 3 tall');
    held.lines.write('warn', 'src/main.ts:4:1: unused');
    held.lines.write('error', 'ReferenceError: sun is not defined');
    return held;
}

function pane(lines = frames().lines, className?: string): Promise<HTMLElement> {
    return mount(<ConsolePane lines={lines} className={className} />);
}

function clear(host: HTMLElement): HTMLButtonElement | null {
    return host.querySelector('.console-clear');
}

function printed(host: HTMLElement): (string | null)[] {
    return [...host.querySelectorAll('.console-line')].map((line) => line.textContent);
}

describe('ConsolePane', () => {
    it('is a section named by its visible Console heading', async () => {
        const host = await pane();
        const section = host.querySelector('section');
        expect(section?.getAttribute('aria-labelledby')).toBe('console-title');
        const heading = section?.querySelector('h2#console-title');
        expect(heading?.textContent).toBe('Console');
        expect(heading?.className).toBe('pane__title');
        expect(heading?.parentElement?.className).toBe('pane__header');
    });

    it('is a console pane panel of a header and a log and keeps the class it is given', async () => {
        const host = await pane(frames().lines, 'side');
        const section = host.querySelector('section');
        expect(section?.className).toBe('pg-panel pg-panel--surface pane pane--console side');
        expect(section?.children.length).toBe(2);
        expect(section?.children[0]?.className).toBe('pane__header');
        expect(section?.children[1]?.className).toBe('console-body');
    });

    it('marks the header with the terminal glyph before the title', async () => {
        const host = await pane();
        const header = host.querySelector('.pane__header');
        const mark = header?.firstElementChild;
        expect(mark?.className).toBe('console-icon');
        expect(mark?.nextElementSibling).toBe(header?.querySelector('h2'));
        const reference = await mount(<TerminalIcon size={14} />);
        expect(mark?.querySelector('svg')?.outerHTML).toBe(
            reference.querySelector('svg')?.outerHTML,
        );
    });

    it('renders the log empty, named, unfocusable, and without a live region of its own', async () => {
        const host = await pane();
        const log = host.querySelector('[role="log"]');
        expect(log?.getAttribute('aria-label')).toBe('Console output');
        expect(log?.hasAttribute('aria-live')).toBe(false);
        expect(log?.hasAttribute('tabindex')).toBe(false);
        expect(log?.className).toBe('console-body');
        expect(log?.childElementCount).toBe(0);
        expect(log?.textContent).toBe('');
    });

    it('prints what a run wrote, oldest first, each marked with its level', async () => {
        const held = written();
        const host = await pane(held.lines);
        await held.flush();

        expect(printed(host)).toEqual([
            'day 1: Pip is 3 tall',
            'src/main.ts:4:1: unused',
            'ReferenceError: sun is not defined',
        ]);
        expect([...host.querySelectorAll('.console-line')].map((line) => line.className)).toEqual([
            'console-line console-line--log',
            'console-line console-line--warn',
            'console-line console-line--error',
        ]);
    });

    it('offers nothing to clear until something has been written, and clears on a press', async () => {
        const empty = await pane();
        expect(clear(empty)?.getAttribute('aria-disabled')).toBe('true');

        const held = written();
        const host = await pane(held.lines);
        await held.flush();
        expect(clear(host)?.hasAttribute('aria-disabled')).toBe(false);
        await act(async () => {
            clear(host)?.click();
        });
        await held.flush();
        expect(printed(host)).toEqual([]);
    });
});

describe('a game that logs every tick', () => {
    it('is drawn once a frame, however many lines the frame wrote', async () => {
        const held = frames();
        let commits = 0;
        const host = await mount(
            <Profiler id="console" onRender={() => (commits += 1)}>
                <ConsolePane lines={held.lines} />
            </Profiler>,
        );
        const before = commits;

        for (let tick = 0; tick < 2_000; tick += 1) held.lines.write('log', `tick ${String(tick)}`);
        // One flush owed for the whole burst, and nothing drawn before the frame.
        expect(held.due()).toBe(1);
        expect(commits).toBe(before);

        await held.flush();
        expect(commits).toBe(before + 1);
        // The last of them, since a game in a loop writes faster than anyone reads.
        expect(printed(host)).toHaveLength(MAX_LINES);
        expect(printed(host).at(-1)).toBe('tick 1999');
        expect(printed(host)[0]).toBe(`tick ${String(2_000 - MAX_LINES)}`);
    });
});
