import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { ThemeProvider } from '@grove/ui';
import { mountEditor } from '../src/editor/monaco';
import { EditorShell } from '../src/shell/EditorShell';
import { PROJECT_PATH } from '../src/project/manifest';
import { CHANNEL } from '../src/run/protocol';
import type { Game } from '../src/run/protocol';
import { draftFromText } from '../src/workspace/files';
import { fakeApi, opened, PLAIN_PROJECT, PROJECT, TEMPLATE_PATH } from './doubles';
import type { OpenGame } from '../src/workspace/session';
import { mount, until, untilSettled } from '@grove/ui/testing';

/** A compile hashes and checks a whole project, which is slower than the waits around it. */
const COMPILE_MS = 10_000;

function frameOf(host: HTMLElement): HTMLIFrameElement | null {
    return host.querySelector<HTMLIFrameElement>('.play-frame');
}

/** The run the stage's document was opened for, or nothing while the frame is blank. */
function runOn(host: HTMLElement): string | undefined {
    const src = frameOf(host)?.getAttribute('src') ?? '';
    if (src === '' || src === 'about:blank') return undefined;
    return new URL(src, window.location.href).searchParams.get('run') ?? undefined;
}

/** What the shell posts to the document its frame holds now, which a new run replaces. */
function posts(host: HTMLElement): { type: string; game?: Game }[] {
    const posted: { type: string; game?: Game }[] = [];
    vi.spyOn(frameOf(host)?.contentWindow as Window, 'postMessage').mockImplementation(
        (message) => {
            posted.push(message as { type: string; game?: Game });
        },
    );
    return posted;
}

/** A message from the run's document, as its sandbox would send one. */
async function fromStage(host: HTMLElement, data: Record<string, unknown>): Promise<void> {
    await act(async () => {
        window.dispatchEvent(
            new MessageEvent('message', {
                source: frameOf(host)?.contentWindow as Window,
                data: { channel: CHANNEL, run: runOn(host), ...data },
            }),
        );
    });
}

/** Presses Play and waits for the stage's document to be opened, and to say it is listening. */
async function played(host: HTMLElement): Promise<{ type: string; game?: Game }[]> {
    await click(play(host));
    await until(() => runOn(host) !== undefined, COMPILE_MS);
    const posted = posts(host);
    await fromStage(host, { type: 'ready' });
    return posted;
}

const mounted = vi.mocked(mountEditor);

async function mountShell(open: OpenGame = opened()): Promise<HTMLElement> {
    const host = await mount(
        <ThemeProvider>
            <EditorShell api={fakeApi()} opened={open} onSessionLapsed={vi.fn()} />
        </ThemeProvider>,
    );
    await untilSettled(host);
    return host;
}

/** A game of plain TypeScript, which is the one shape the sandboxed stage can still run. */
function plainGame(): OpenGame {
    return opened({
        files: [draftFromText('src/main.ts', 'console.log("hello");')],
        project: PLAIN_PROJECT,
        openPath: 'src/main.ts',
    });
}

function settingsNote(host: HTMLElement): string | undefined {
    return host.querySelector('.settings-panel__note')?.textContent ?? undefined;
}

function railButton(host: HTMLElement, controls = 'grove-ai-panel'): HTMLButtonElement | null {
    return host.querySelector<HTMLButtonElement>(`nav [aria-controls="${controls}"]`);
}

/** The mocked handle the last mount produced, which is what a run compiles through. */
function workbench(): { emit: Mock; syncFiles: Mock } {
    const last = mounted.mock.results.at(-1);
    if (last === undefined) throw new Error('the editor never mounted');
    return last.value as { emit: Mock; syncFiles: Mock };
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
    vi.restoreAllMocks();
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

    it('opens the code editor on the file the template names, named Code', async () => {
        const host = await mountShell();
        const options = mounted.mock.lastCall?.[1];
        expect(options?.file?.path).toBe(TEMPLATE_PATH);
        expect(options?.file?.value).toContain('extends TopDownMovement');
        const panel = host.querySelector('.pane--editor [role="tabpanel"]');
        expect(panel?.getAttribute('aria-labelledby')).toBe('tab-src-player-ts');
        expect(panel?.querySelector('.editor-host')).not.toBeNull();
    });

    it('keeps the manifest out of the tree and out of the compiler', async () => {
        const host = await mountShell();
        const names = [...host.querySelectorAll('.tree__name')].map((name) => name.textContent);
        expect(names).not.toContain(PROJECT_PATH);
        const synced = workbench().syncFiles.mock.lastCall?.[0] as { path: string }[];
        expect(synced.map((file) => file.path)).toEqual([TEMPLATE_PATH]);
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

    it('puts settings at the foot of the rail and discloses it like any other view', async () => {
        const host = await mountShell();
        const rail = [...host.querySelectorAll<HTMLButtonElement>('nav .rail__view')];
        expect(rail.map((button) => button.getAttribute('aria-label'))).toEqual([
            'Explorer',
            'Grove AI',
            'Settings',
        ]);
        const gear = rail.at(-1);
        expect(gear?.className).toContain('rail__foot');

        await click(gear);
        const settings = host.querySelector<HTMLElement>('aside#settings-panel');
        expect(gear?.getAttribute('aria-expanded')).toBe('true');
        expect(settings?.hidden).toBe(false);
        expect(document.activeElement).toBe(settings);

        await click(gear);
        expect(settings?.hidden).toBe(true);
        expect(document.activeElement).toBe(gear);
    });

    it('writes a changed setting into the manifest, which leaves the game unsaved', async () => {
        const host = await mountShell(opened({ seeded: false }));
        expect(host.querySelector('.topbar__state')?.textContent).toBe('Up to date');

        await click(railButton(host, 'settings-panel'));
        const players = host.querySelector<HTMLInputElement>(
            '#settings-panel input[type="number"]',
        );
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
                players,
                '8',
            );
            players?.dispatchEvent(new Event('input', { bubbles: true }));
        });

        expect(host.querySelector('.topbar__state')?.textContent).toBe('Unsaved changes');
        expect(settingsNote(host)).toContain('2 scripts in 1 file');
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
        stubMatchMedia('(max-width: 384px)');
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

    it('plays a game the engine drives in a sandboxed document, handed the compile over', async () => {
        const host = await mountShell();
        const created = vi.spyOn(URL, 'createObjectURL');
        const posted = await played(host);

        expect(playStatus(host)).toBe('Running');
        await until(() => printed(host).length > 0);
        expect(printed(host)[0]).toBe(
            'Build succeeded: 2 scripts in 1 file: 30 Hz, up to 4 players',
        );
        expect(frameOf(host)?.getAttribute('sandbox')).toBe('allow-scripts');
        expect(new URL(frameOf(host)?.src ?? '').pathname).toBe('/preview-world.html');
        // Built from the compile, not from what is on screen: a world is the code as it was when
        // the button was pressed, and it is evaluated over there, never in this page.
        const game = posted.find((message) => message.type === 'run')?.game;
        expect(game?.mode).toBe('world');
        expect(game?.mode === 'world' && game.project.scriptModules[0]?.path).toBe(TEMPLATE_PATH);
        expect(game?.mode === 'world' && game.name).toBe('Rowan');
        expect(created).not.toHaveBeenCalled();
    });

    it('says the world is starting until its document says it is running', async () => {
        const host = await mountShell();
        await played(host);

        await fromStage(host, { type: 'status', status: 'starting' });
        expect(host.querySelector('.play-stage [role="status"]')?.textContent).toBe(
            'Starting the game…',
        );
        expect(host.querySelector('.play-stage')?.getAttribute('aria-busy')).toBe('true');

        await fromStage(host, { type: 'status', status: 'running' });
        expect(host.querySelector('.play-stage [role="status"]')).toBeNull();
    });

    it('prints what the run’s document writes, and believes no other window', async () => {
        const host = await mountShell();
        await played(host);

        await fromStage(host, { type: 'line', level: 'warn', text: 'from the world' });
        await act(async () => {
            window.dispatchEvent(
                new MessageEvent('message', {
                    source: window,
                    data: {
                        channel: CHANNEL,
                        run: runOn(host),
                        type: 'line',
                        level: 'error',
                        text: 'from this page',
                    },
                }),
            );
        });
        await until(() => printed(host).includes('from the world'));
        expect(printed(host)).not.toContain('from this page');
    });

    it('drops the run’s document when the run is stopped', async () => {
        const host = await mountShell();
        await played(host);

        await click(stop(host));
        expect(frameOf(host)?.getAttribute('src')).toBe('about:blank');
        expect(playStatus(host)).toBe('Idle');
    });

    it('sends pause and resume to the run’s document', async () => {
        const host = await mountShell();
        await played(host);
        const posted = posts(host);

        await click(play(host));
        expect(playStatus(host)).toBe('Paused');
        await click(play(host));

        expect(posted.map((message) => message.type)).toEqual(['pause', 'resume']);
    });

    it('stamps what the code declares back into the manifest it compiled', async () => {
        // A manifest that declares nothing, so what the settings panel reports afterwards is what
        // the compile read off the code rather than what the fixture already held.
        const host = await mountShell(
            opened({ project: { ...PROJECT, scriptModules: [], gameScripts: [] } }),
        );
        await click(railButton(host, 'settings-panel'));
        expect(settingsNote(host)).toContain('0 scripts in 0 files');

        await click(play(host));
        await until(() => runOn(host) !== undefined, COMPILE_MS);
        expect(settingsNote(host)).toContain('2 scripts in 1 file');
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
        await until(() => printed(host).length === 2);

        expect(playStatus(host)).toBe('Idle');
        expect(runOn(host)).toBeUndefined();
        expect(printed(host)).toEqual([
            "src/main.ts:4:9: ')' expected",
            'that did not compile, so there is nothing to run',
        ]);
    });

    it('runs plain TypeScript in its own document, started at its entry', async () => {
        const host = await mountShell(plainGame());
        workbench().emit.mockResolvedValue({
            modules: { 'src/main.js': 'console.log("hello");' },
            problems: [],
        });

        const posted = await played(host);
        expect(new URL(frameOf(host)?.src ?? '').pathname).toBe('/preview-plain.html');
        expect(posted.find((message) => message.type === 'run')?.game).toMatchObject({
            mode: 'plain',
            entry: 'src/main.js',
            modules: { 'src/main.js': 'console.log("hello");' },
        });
    });

    it('drives the play pane status once a run has something to start', async () => {
        const host = await mountShell(plainGame());
        workbench().emit.mockResolvedValue({
            modules: { 'src/main.js': 'console.log("hello");' },
            problems: [],
        });

        await click(play(host));
        await until(() => playStatus(host) !== 'Idle', COMPILE_MS);
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
