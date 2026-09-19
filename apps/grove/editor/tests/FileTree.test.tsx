import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FileTree } from '../src/explorer/FileTree';
import { projectTree } from './doubles';
import { mount } from './helpers';

function tree(onOpen = vi.fn(), activePath: string | null = 'src/main.ts'): Promise<HTMLElement> {
    return mount(<FileTree nodes={projectTree()} activePath={activePath} onOpen={onOpen} />);
}

function items(host: HTMLElement): HTMLElement[] {
    return [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')];
}

function names(host: HTMLElement): (string | null | undefined)[] {
    return items(host).map((item) => item.querySelector('.tree__name')?.textContent);
}

function press(host: HTMLElement, key: string): Promise<void> {
    return act(async () => {
        host.querySelector('[role="tree"]')?.dispatchEvent(
            new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        );
    });
}

function click(item: Element | undefined): Promise<void> {
    return act(async () => {
        (item as HTMLElement | undefined)?.click();
    });
}

describe('FileTree', () => {
    it('is a labelled tree that opens every folder on first paint', async () => {
        const host = await tree();
        expect(host.querySelector('[role="tree"]')?.getAttribute('aria-label')).toBe('Files');
        // Folders above files, each side alphabetical: the tree is derived from the paths the game
        // holds, so its order is a rule rather than the order somebody typed the files in.
        expect(names(host)).toEqual([
            'hud',
            'hud.ts',
            'src',
            'garden.ts',
            'main.ts',
            'sprout.ts',
            'game.config.ts',
        ]);
        const [hud] = items(host);
        expect(hud?.getAttribute('aria-expanded')).toBe('true');
        expect(hud?.getAttribute('aria-level')).toBe('1');
        expect(items(host)[1]?.getAttribute('aria-level')).toBe('2');
    });

    it('marks files, not folders, as selectable and shows the active one selected', async () => {
        const host = await tree(vi.fn(), 'src/sprout.ts');
        const [hud, hudFile, , , , sprout] = items(host);
        expect(hud?.hasAttribute('aria-selected')).toBe(true);
        expect(hud?.getAttribute('aria-selected')).toBe('false');
        expect(hud?.hasAttribute('aria-expanded')).toBe(true);
        expect(hudFile?.hasAttribute('aria-expanded')).toBe(false);
        expect(sprout?.getAttribute('aria-selected')).toBe('true');
        expect(sprout?.className).toBe('tree__item tree__item--selected');
    });

    it('opens a file when it is clicked and leaves folders to disclose', async () => {
        const onOpen = vi.fn();
        const host = await tree(onOpen);
        await click(items(host)[1]);
        expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ path: 'hud/hud.ts' }));

        onOpen.mockClear();
        await click(items(host)[0]);
        expect(onOpen).not.toHaveBeenCalled();
        expect(items(host)[0]?.getAttribute('aria-expanded')).toBe('false');
        expect(names(host)).toEqual([
            'hud',
            'src',
            'garden.ts',
            'main.ts',
            'sprout.ts',
            'game.config.ts',
        ]);
    });

    it('carries one tab stop and moves it with the arrow keys', async () => {
        const host = await tree();
        expect(items(host).map((item) => item.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1]);

        await press(host, 'ArrowDown');
        expect(items(host).map((item) => item.tabIndex)).toEqual([-1, 0, -1, -1, -1, -1, -1]);
        expect(document.activeElement).toBe(items(host)[1]);

        await press(host, 'ArrowUp');
        expect(document.activeElement).toBe(items(host)[0]);
    });

    it('collapses and expands a folder with the left and right arrows', async () => {
        const host = await tree();
        await press(host, 'ArrowLeft');
        expect(items(host)[0]?.getAttribute('aria-expanded')).toBe('false');
        expect(names(host)).toEqual([
            'hud',
            'src',
            'garden.ts',
            'main.ts',
            'sprout.ts',
            'game.config.ts',
        ]);

        await press(host, 'ArrowRight');
        expect(items(host)[0]?.getAttribute('aria-expanded')).toBe('true');
        expect(names(host)).toHaveLength(7);
    });

    it('walks from a file back to the folder that holds it', async () => {
        const host = await tree();
        await press(host, 'ArrowDown');
        await press(host, 'ArrowLeft');
        expect(document.activeElement).toBe(items(host)[0]);
    });

    it('jumps to the ends with Home and End', async () => {
        const host = await tree();
        await press(host, 'End');
        expect(document.activeElement).toBe(items(host).at(-1));
        await press(host, 'Home');
        expect(document.activeElement).toBe(items(host)[0]);
    });

    it('opens the focused file with Enter and with Space', async () => {
        const onOpen = vi.fn();
        const host = await tree(onOpen);
        await press(host, 'ArrowDown');
        await press(host, 'Enter');
        expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'hud/hud.ts' }));

        await press(host, 'ArrowDown');
        await press(host, 'ArrowDown');
        await press(host, ' ');
        expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'src/garden.ts' }));
    });
});
