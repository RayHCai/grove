import { act, useReducer, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@grove/ui';
import { EditorPane } from '../src/editor/EditorPane';
import { tabsReducer } from '../src/editor/tabs';
import { fileAt } from './doubles';
import { mount, untilSettled } from './helpers';

const main = fileAt('src/main.ts');
const sprout = fileAt('src/sprout.ts');

interface PaneOptions {
    className?: string | undefined;
    files?: readonly ReturnType<typeof fileAt>[];
    activePath?: string | null;
    onSelect?: (path: string) => void;
    onClose?: (path: string) => void;
}

async function pane(options: PaneOptions = {}): Promise<HTMLElement> {
    const {
        className,
        files = [main],
        activePath = main.path,
        onSelect = vi.fn(),
        onClose = vi.fn(),
    } = options;
    const host = await mount(
        <ThemeProvider>
            <EditorPane
                files={files}
                activePath={activePath}
                onSelect={onSelect}
                onClose={onClose}
                mode="ts"
                onModeChange={vi.fn()}
                className={className}
            />
        </ThemeProvider>,
    );
    await untilSettled(host);
    return host;
}

function press(target: Element | null | undefined, key: string): Promise<void> {
    return act(async () => {
        target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
}

const garden = fileAt('src/garden.ts');

/** The pane is controlled, so the arrow and Delete keys only move against real state. */
function Stateful(): React.JSX.Element {
    const [tabs, dispatch] = useReducer(tabsReducer, 'src/main.ts', (path: string) => ({
        open: ['src/main.ts', 'src/sprout.ts', 'src/garden.ts'],
        active: path,
    }));
    const [mode, setMode] = useState<'ts' | 'blocks'>('ts');
    const open = [main, sprout, garden].filter((file) => tabs.open.includes(file.path));
    return (
        <EditorPane
            files={open}
            activePath={tabs.active}
            onSelect={(path) => dispatch({ type: 'select', path })}
            onClose={(path) => dispatch({ type: 'close', path })}
            mode={mode}
            onModeChange={setMode}
        />
    );
}

describe('EditorPane', () => {
    it('is a section named by a hidden Editor heading, wearing the pane classes', async () => {
        const host = await pane({ className: 'cell' });
        const section = host.querySelector('section');
        expect(section?.className).toBe('pg-panel pg-panel--surface pane pane--editor cell');
        expect(section?.getAttribute('aria-labelledby')).toBe('editor-title');
        const heading = section?.querySelector('h2#editor-title');
        expect(heading?.textContent).toBe('Editor');
        expect(heading?.className).toBe('pg-visually-hidden');
    });

    it('lists the open files as a tablist, the active one selected and tabbable', async () => {
        const host = await pane({ files: [main, sprout], activePath: sprout.path });
        const strip = host.querySelector('[role="tablist"]');
        expect(strip?.getAttribute('aria-label')).toBe('Open files');
        const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
        expect(tabs.map((tab) => tab.textContent)).toEqual(['main.ts', 'sprout.ts']);
        expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true']);
        expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0]);
        expect(tabs[1]?.id).toBe('tab-src-sprout-ts');
        expect(tabs[0]?.querySelector('svg')?.getAttribute('width')).toBe('14');
    });

    it('selects a file when its tab is clicked', async () => {
        const onSelect = vi.fn();
        const host = await pane({ files: [main, sprout], onSelect });
        await act(async () => {
            host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]?.click();
        });
        expect(onSelect).toHaveBeenCalledWith('src/sprout.ts');
    });

    it('moves between tabs with the arrow keys and Home and End', async () => {
        const host = await mount(
            <ThemeProvider>
                <Stateful />
            </ThemeProvider>,
        );
        await untilSettled(host);
        const strip = host.querySelector('[role="tablist"]');
        const selected = (): string | null | undefined =>
            host.querySelector('[aria-selected="true"]')?.textContent;
        expect(selected()).toBe('main.ts');

        await press(strip, 'ArrowRight');
        expect(selected()).toBe('sprout.ts');
        await press(strip, 'ArrowRight');
        expect(selected()).toBe('garden.ts');
        await press(strip, 'ArrowLeft');
        expect(selected()).toBe('sprout.ts');
        await press(strip, 'Home');
        expect(selected()).toBe('main.ts');
        await press(strip, 'End');
        expect(selected()).toBe('garden.ts');

        // The moved tab takes focus with it, so the next arrow starts where the last one landed.
        expect(document.activeElement).toBe(host.querySelector('[aria-selected="true"]'));
    });

    it('closes the active file with Delete and lands on its neighbour', async () => {
        const host = await mount(
            <ThemeProvider>
                <Stateful />
            </ThemeProvider>,
        );
        await untilSettled(host);
        const strip = host.querySelector('[role="tablist"]');
        await press(strip, 'Delete');
        expect([...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
            'sprout.ts',
            'garden.ts',
        ]);
        expect(host.querySelector('[aria-selected="true"]')?.textContent).toBe('sprout.ts');
        expect(document.activeElement).toBe(host.querySelector('[aria-selected="true"]'));
    });

    it('closes a file from its close button and from the Delete key', async () => {
        const onClose = vi.fn();
        const host = await pane({ files: [main, sprout], onClose });
        const close = host.querySelector<HTMLButtonElement>('[aria-label="Close sprout.ts"]');
        expect(close?.tabIndex).toBe(-1);
        await act(async () => {
            close?.click();
        });
        expect(onClose).toHaveBeenLastCalledWith('src/sprout.ts');

        await press(host.querySelector('[role="tablist"]'), 'Delete');
        expect(onClose).toHaveBeenLastCalledWith('src/main.ts');
    });

    it('puts the mode combobox in the header, named Mode with the label hidden', async () => {
        const host = await pane();
        const trigger = host.querySelector<HTMLElement>('.pane__header [role="combobox"]');
        expect(trigger?.getAttribute('aria-labelledby')).toBe(
            'editor-mode-label editor-mode-value',
        );
        expect(trigger?.title).toBe('Mode');
        expect(host.querySelector('#editor-mode-label')?.className).toBe('pg-visually-hidden');
        expect(host.querySelector('#editor-mode-value')?.textContent).toBe('TypeScript');

        await act(async () => {
            trigger?.click();
        });
        const options = host.querySelectorAll('[role="option"]');
        expect(options.length).toBe(2);
        expect(options[1]?.getAttribute('aria-disabled')).toBe('true');
        expect(options[1]?.querySelector('.pg-select__description')?.textContent).toBe(
            'Coming soon',
        );
    });

    it('fills the body with the tab panel the active tab names', async () => {
        const host = await pane();
        const panel = host.querySelector('section > [role="tabpanel"]');
        expect(panel?.id).toBe('editor-tabpanel');
        expect(panel?.className).toBe('editor-body pane__body');
        expect(panel?.getAttribute('aria-labelledby')).toBe('tab-src-main-ts');
        expect(panel?.getAttribute('aria-busy')).toBe('false');
        expect(panel?.querySelector('.editor-host')).not.toBeNull();
        expect(host.querySelector('[role="tab"]')?.getAttribute('aria-controls')).toBe(
            'editor-tabpanel',
        );
    });

    it('says what to do when every file is closed', async () => {
        const host = await pane({ files: [], activePath: null });
        expect(host.querySelectorAll('[role="tab"]')).toHaveLength(0);
        const panel = host.querySelector('[role="region"]');
        expect(panel?.getAttribute('aria-label')).toBe('Code');
        expect(host.querySelector('.editor-status')?.textContent).toBe(
            'Pick a file in the Explorer to start editing.',
        );
    });
});
