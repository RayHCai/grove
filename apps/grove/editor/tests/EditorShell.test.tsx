import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { ThemeProvider } from '@grove/ui';
import { mountEditor } from '../src/editor/monaco';
import { EditorShell } from '../src/shell/EditorShell';
import { fakeApi, opened } from './doubles';
import { mount, untilSettled } from './helpers';

const mounted = vi.mocked(mountEditor);

async function mountShell(): Promise<HTMLElement> {
    const host = await mount(
        <ThemeProvider>
            <EditorShell api={fakeApi()} opened={opened()} onSignedOut={vi.fn()} />
        </ThemeProvider>,
    );
    await untilSettled(host);
    return host;
}

function railButton(host: HTMLElement, controls = 'grove-ai-panel'): HTMLButtonElement | null {
    return host.querySelector<HTMLButtonElement>(`nav [aria-controls="${controls}"]`);
}

/** The mocked handle the last mount produced, which is what a run compiles through. */
function workbench(): { emit: Mock } {
    const last = mounted.mock.results.at(-1);
    if (last === undefined) throw new Error('the editor never mounted');
    return last.value as { emit: Mock };
}

function play(host: HTMLElement): HTMLButtonElement | null {
    return host.querySelector<HTMLButtonElement>('.pane--play .transport__play');
}

function stop(host: HTMLElement): HTMLButtonElement | null {
    return host.querySelector<HTMLButtonElement>('.pane--play [aria-label="Stop"]');
}

function playStatus(host: HTMLElement): string | undefined {
    return host.querySelector('.pane--play [role="status"]')?.textContent ?? undefined;
}

function printed(host: HTMLElement): (string | null)[] {
    return [...host.querySelectorAll('.console-line')].map((line) => line.textContent);
}

function aside(host: HTMLElement): HTMLElement | null {
    return host.querySelector<HTMLElement>('aside#grove-ai-panel');
}

async function click(button: HTMLElement | null | undefined): Promise<void> {
    await act(async () => {
        button?.click();
    });
}

async function escape(target: Element | null | undefined): Promise<void> {
    await act(async () => {
        target?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
    });
}

/** jsdom has no matchMedia; this one answers the given queries with `true` and the rest with `false`. */
function stubMatchMedia(...matching: string[]): void {
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: matching.includes(query),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    }));
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('EditorShell', () => {
    it('mounts every landmark, the aside included while hidden', async () => {
        const host = await mountShell();
        expect(host.querySelectorAll('h1')).toHaveLength(1);
        expect(host.querySelector('h1')?.textContent).toBe('Grove editor');
        expect(host.querySelector('header')?.className).toBe('topbar');
        expect(host.querySelector('nav')?.getAttribute('aria-label')).toBe('Editor');
        expect(aside(host)?.getAttribute('aria-label')).toBe('Grove AI');
        expect(aside(host)?.hidden).toBe(true);
        expect(host.querySelector('aside#explorer-panel')?.getAttribute('aria-label')).toBe(
            'Explorer',
        );
        expect(host.querySelector('main')?.className).toBe('workspace');
        expect(host.querySelector('.pg-tilestrip')).not.toBeNull();
    });

    it('names the editor, play and console sections and lays them out in the grid', async () => {
        const host = await mountShell();
        const grid = host.querySelector('main > .workspace__grid');
        expect(grid?.children.length).toBe(2);
        const [editor, side] = grid?.children ?? [];
        expect(editor?.tagName).toBe('SECTION');
        expect(editor?.getAttribute('aria-labelledby')).toBe('editor-title');
        expect(editor?.classList.contains('pane--editor')).toBe(true);
        expect(side?.className).toBe('workspace__side');
        expect(side?.children.length).toBe(2);
        const [preview, console] = side?.children ?? [];
        expect(preview?.tagName).toBe('SECTION');
        expect(preview?.getAttribute('aria-labelledby')).toBe('play-title');
        expect(preview?.classList.contains('pane--play')).toBe(true);
        expect(console?.tagName).toBe('SECTION');
        expect(console?.getAttribute('aria-labelledby')).toBe('console-title');
        expect(console?.classList.contains('pane--console')).toBe(true);
        const headings = [...host.querySelectorAll('main h2')].map((h) => h.textContent);
        expect(headings).toEqual(['Editor', 'Play', 'Console']);
    });

    it('opens the code editor on the starter script, named Code', async () => {
        const host = await mountShell();
        const options = mounted.mock.lastCall?.[1];
        expect(options?.file?.path).toBe('src/main.ts');
        expect(options?.file?.value).toContain('Press Play to run this');
        const panel = host.querySelector('.pane--editor [role="tabpanel"]');
        expect(panel?.getAttribute('aria-labelledby')).toBe('tab-src-main-ts');
        expect(panel?.querySelector('.editor-host')).not.toBeNull();
    });

    it('keeps the mode select in the editor pane header, out of the top bar', async () => {
        const host = await mountShell();
        expect(host.querySelector('header [role="combobox"]')).toBeNull();
        const trigger = host.querySelector('.pane--editor .pane__header [role="combobox"]');
        expect(trigger?.getAttribute('aria-labelledby')).toBe(
            'editor-mode-label editor-mode-value',
        );
        expect(host.querySelector('#editor-mode-value')?.textContent).toBe('TypeScript');
    });

    it('discloses the Grove AI panel from the rail and moves focus into it', async () => {
        const host = await mountShell();
        await click(railButton(host, 'explorer-panel'));
        const button = railButton(host);
        expect(button?.className).toBe('pg-iconbtn pg-iconbtn--ghost rail__view');
        expect(button?.getAttribute('aria-expanded')).toBe('false');
        expect(button?.hasAttribute('aria-pressed')).toBe(false);

        await click(button);
        expect(button?.getAttribute('aria-expanded')).toBe('true');
        expect(aside(host)?.hidden).toBe(false);
        expect(aside(host)?.getAttribute('data-open')).toBe('true');
        expect(document.activeElement).toBe(aside(host));

        await click(button);
        expect(button?.getAttribute('aria-expanded')).toBe('false');
        expect(aside(host)?.hidden).toBe(true);
        expect(document.activeElement).toBe(button);
    });

    it('closes on Escape inside the panel and returns focus to the rail button', async () => {
        const host = await mountShell();
        await click(railButton(host));
        await escape(aside(host)?.querySelector('textarea'));
        expect(aside(host)?.hidden).toBe(true);
        expect(railButton(host)?.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(railButton(host));
    });

    it('closes from the close button with the same focus return', async () => {
        const host = await mountShell();
        await click(railButton(host));
        await click(aside(host)?.querySelector<HTMLButtonElement>('[aria-label="Close"]'));
        expect(aside(host)?.hidden).toBe(true);
        expect(document.activeElement).toBe(railButton(host));
    });

    it('makes the workspace inert while the open panel covers it edge to edge', async () => {
        stubMatchMedia('(max-width: 480px)');
        const host = await mountShell();
        const main = host.querySelector('main');
        // The explorer is open on arrival, so the workspace starts covered at this width.
        expect(main?.hasAttribute('inert')).toBe(true);

        await click(railButton(host, 'explorer-panel'));
        expect(main?.hasAttribute('inert')).toBe(false);

        await click(railButton(host));
        expect(main?.hasAttribute('inert')).toBe(true);

        await click(aside(host)?.querySelector<HTMLButtonElement>('[aria-label="Close"]'));
        expect(main?.hasAttribute('inert')).toBe(false);
    });

    it('keeps the workspace live beside the open panel at wider viewports', async () => {
        stubMatchMedia();
        const host = await mountShell();
        await click(railButton(host));
        expect(aside(host)?.hidden).toBe(false);
        expect(host.querySelector('main')?.hasAttribute('inert')).toBe(false);
    });

    it('leaves the panel open when Escape is pressed in the code region', async () => {
        const host = await mountShell();
        await click(railButton(host));
        await escape(host.querySelector('.editor-host'));
        expect(aside(host)?.hidden).toBe(false);
        expect(railButton(host)?.getAttribute('aria-expanded')).toBe('true');
    });

    it('flips data-theme on <html> from the rail toggle', async () => {
        const host = await mountShell();
        const toggle = host.querySelector<HTMLButtonElement>('nav [aria-label="Dark mode"]');
        expect(toggle?.className).toBe('pg-iconbtn pg-iconbtn--ghost rail__theme');
        expect(document.documentElement.dataset.theme).toBe('light');
        expect(toggle?.getAttribute('aria-pressed')).toBe('false');

        await click(toggle);
        expect(document.documentElement.dataset.theme).toBe('dark');
        expect(toggle?.getAttribute('aria-pressed')).toBe('true');

        await click(toggle);
        expect(document.documentElement.dataset.theme).toBe('light');
    });

    it('keeps the run controls in the play pane header, out of the top bar', async () => {
        const host = await mountShell();
        expect(host.querySelector('header [role="group"]')).toBeNull();
        const header = host.querySelector('.pane--play .pane__header');
        expect(header?.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe(
            'Run controls',
        );
        expect(playStatus(host)).toBe('Idle');
        expect(header?.querySelector('[aria-label="Stop"]')?.getAttribute('aria-disabled')).toBe(
            'true',
        );
    });

    it('compiles before it runs, and stays idle when there is nothing to run', async () => {
        const host = await mountShell();
        await click(play(host));

        expect(playStatus(host)).toBe('Idle');
        expect(printed(host)).toEqual(['a run starts at src/main.ts, and this game has none']);
    });

    it('refuses to run what did not parse, and says which line stopped it', async () => {
        const host = await mountShell();
        workbench().emit.mockResolvedValue({
            modules: {},
            problems: [
                {
                    path: 'src/main.ts',
                    line: 4,
                    column: 9,
                    message: "')' expected",
                    severity: 'error',
                    syntactic: true,
                },
            ],
        });
        await click(play(host));

        expect(playStatus(host)).toBe('Idle');
        expect(printed(host)).toEqual([
            "src/main.ts:4:9 — ')' expected",
            'that did not compile, so there is nothing to run',
        ]);
    });

    it('drives the play pane status once a run has something to start', async () => {
        const host = await mountShell();
        workbench().emit.mockResolvedValue({
            modules: { 'src/main.js': 'console.log("hello");' },
            problems: [],
        });

        await click(play(host));
        expect(playStatus(host)).toBe('Running');
        expect(play(host)?.textContent).toBe('Pause');
        expect(stop(host)?.hasAttribute('aria-disabled')).toBe(false);

        await click(play(host));
        expect(playStatus(host)).toBe('Paused');

        await click(stop(host));
        expect(playStatus(host)).toBe('Idle');
        expect(play(host)?.textContent).toBe('Play');
    });
});
