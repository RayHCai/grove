import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TerminalIcon } from '@grove/ui';
import { ConsolePane } from '../src/console/ConsolePane';
import type { RunLine } from '../src/run/host';
import { mount } from './helpers';

const LINES: RunLine[] = [
    { id: 1, level: 'log', text: 'day 1: Pip is 3 tall' },
    { id: 2, level: 'warn', text: 'src/main.ts:4:1 — unused' },
    { id: 3, level: 'error', text: 'ReferenceError: sun is not defined' },
];

function pane(
    lines: readonly RunLine[] = [],
    onClear = vi.fn(),
    className?: string,
): Promise<HTMLElement> {
    return mount(<ConsolePane lines={lines} onClear={onClear} className={className} />);
}

function clear(host: HTMLElement): HTMLButtonElement | null {
    return host.querySelector('.console-clear');
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
        const host = await pane([], vi.fn(), 'side');
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
        const host = await pane(LINES);
        const printed = [...host.querySelectorAll('.console-line')];
        expect(printed.map((line) => line.textContent)).toEqual([
            'day 1: Pip is 3 tall',
            'src/main.ts:4:1 — unused',
            'ReferenceError: sun is not defined',
        ]);
        expect(printed.map((line) => line.className)).toEqual([
            'console-line console-line--log',
            'console-line console-line--warn',
            'console-line console-line--error',
        ]);
    });

    it('offers nothing to clear until something has been written', async () => {
        const empty = await pane();
        expect(clear(empty)?.getAttribute('aria-disabled')).toBe('true');

        const onClear = vi.fn();
        const written = await pane(LINES, onClear);
        expect(clear(written)?.hasAttribute('aria-disabled')).toBe(false);
        await act(async () => {
            clear(written)?.click();
        });
        expect(onClear).toHaveBeenCalledOnce();
    });
});
