import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ExplorerPanel } from '../src/explorer/ExplorerPanel';
import type { ProjectFile } from '../src/project/files';
import { projectTree } from './doubles';
import { mount } from './helpers';

interface PanelParts {
    onClose?: () => void;
    onOpenFile?: (file: ProjectFile) => void;
    onAddFile?: (path: string) => void;
    onImportFile?: (file: File) => void;
    onRemoveFile?: (path: string) => void;
    activePath?: string | null;
}

function button(host: HTMLElement, label: string): HTMLButtonElement | null {
    return host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

/** Right-clicks the row named `name`, which is what opens its menu. */
async function rightClick(host: HTMLElement, name: string): Promise<void> {
    const row = [...host.querySelectorAll('.tree__item')].find(
        (item) => item.querySelector('.tree__name')?.textContent === name,
    );
    await act(async () => {
        row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
}

function panel(open: boolean, parts: PanelParts = {}): Promise<HTMLElement> {
    return mount(
        <ExplorerPanel
            open={open}
            projectName="Pip's Garden"
            nodes={projectTree()}
            activePath={parts.activePath ?? 'src/main.ts'}
            onOpenFile={parts.onOpenFile ?? vi.fn()}
            onAddFile={parts.onAddFile ?? vi.fn()}
            onImportFile={parts.onImportFile ?? vi.fn()}
            onRemoveFile={parts.onRemoveFile ?? vi.fn()}
            onClose={parts.onClose ?? vi.fn()}
        />,
    );
}

describe('ExplorerPanel', () => {
    it('is the aside the rail controls, hidden and focusable by script', async () => {
        const host = await panel(false);
        const aside = host.querySelector<HTMLElement>('aside');
        expect(aside?.id).toBe('explorer-panel');
        expect(aside?.getAttribute('aria-label')).toBe('Explorer');
        expect(aside?.className).toBe('side-panel explorer-panel');
        expect(aside?.tabIndex).toBe(-1);
        expect(aside?.hidden).toBe(true);
        expect(aside?.getAttribute('data-open')).toBe('false');
    });

    it('heads the open panel with a title, a close button and the project name', async () => {
        const host = await panel(true);
        const aside = host.querySelector<HTMLElement>('aside');
        expect(aside?.hidden).toBe(false);
        const head = aside?.querySelector('.side-panel__head');
        expect(head?.querySelector('h2')?.textContent).toBe('Explorer');
        expect(head?.querySelector('h2')?.className).toBe('side-panel__title');
        expect(head?.querySelector('[aria-label="Close"]')?.className).toBe(
            'pg-iconbtn pg-iconbtn--ghost pg-iconbtn--sm',
        );
        expect(aside?.querySelector('.explorer-panel__project')?.textContent).toBe("Pip's Garden");
        expect(aside?.querySelector('[role="tree"]')).not.toBeNull();
    });

    it('closes from the button and from Escape inside it', async () => {
        const onClose = vi.fn();
        const host = await panel(true, { onClose });
        await act(async () => {
            host.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click();
        });
        expect(onClose).toHaveBeenCalledTimes(1);

        await act(async () => {
            host.querySelector('[role="tree"]')?.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
            );
        });
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('hands a clicked file up to the caller', async () => {
        const onOpenFile = vi.fn();
        const host = await panel(true, { onOpenFile });
        const items = [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')];
        await act(async () => {
            items[1]?.click();
        });
        expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'hud.ts' }));
    });

    it('keeps what changes the file set beside the game’s name, as two icons', async () => {
        const host = await panel(true);
        const project = host.querySelector('.explorer-panel__project');
        expect(project?.querySelector('.explorer-panel__name')?.textContent).toBe("Pip's Garden");
        const actions = [...(project?.querySelectorAll('button') ?? [])];
        expect(actions.map((each) => each.getAttribute('aria-label'))).toEqual([
            'New file',
            'Import file',
        ]);
    });

    it('names a new file under the source folder the tree is rooted at', async () => {
        const onAddFile = vi.fn();
        const host = await panel(true, { onAddFile });
        await act(async () => {
            button(host, 'New file')?.click();
        });

        const field = host.querySelector<HTMLInputElement>('.explorer-panel__new input');
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
                field,
                'enemy.ts',
            );
            field?.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => {
            host.querySelector('.explorer-panel__new')?.dispatchEvent(
                new Event('submit', { bubbles: true, cancelable: true }),
            );
        });

        expect(onAddFile).toHaveBeenCalledWith('src/enemy.ts');
        expect(host.querySelector('.explorer-panel__new')).toBeNull();
    });

    it('removes a file from its own menu rather than from a button on the panel', async () => {
        const onRemoveFile = vi.fn();
        const host = await panel(true, { onRemoveFile });
        expect(button(host, 'Delete')).toBeNull();

        await rightClick(host, 'main.ts');
        const menu = host.querySelector('[role="menu"]');
        expect(menu?.getAttribute('aria-label')).toBe('main.ts');
        await act(async () => {
            menu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click();
        });

        expect(onRemoveFile).toHaveBeenCalledWith('src/main.ts');
        expect(host.querySelector('[role="menu"]')).toBeNull();
    });

    it('removes every file under a folder the menu was opened on', async () => {
        const onRemoveFile = vi.fn();
        const host = await panel(true, { onRemoveFile });
        await rightClick(host, 'hud');
        await act(async () => {
            host.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click();
        });
        expect(onRemoveFile).toHaveBeenCalledWith('hud/hud.ts');
    });

    it('closes the menu on Escape, and leaves the panel open behind it', async () => {
        const onClose = vi.fn();
        const host = await panel(true, { onClose });
        await rightClick(host, 'main.ts');
        await act(async () => {
            host.querySelector('[role="menu"]')?.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
            );
        });
        expect(host.querySelector('[role="menu"]')).toBeNull();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('imports a file dropped onto it from the machine', async () => {
        const onImportFile = vi.fn();
        const host = await panel(true, { onImportFile });
        const body = host.querySelector('.explorer-panel__body');
        const picked = new File(['x'], 'sprite.png', { type: 'image/png' });
        const transfer = { types: ['Files'], files: [picked], dropEffect: 'none' };

        await act(async () => {
            const over = new Event('dragover', { bubbles: true, cancelable: true });
            Object.defineProperty(over, 'dataTransfer', { value: transfer });
            body?.dispatchEvent(over);
        });
        expect(body?.getAttribute('data-dropping')).toBe('true');

        await act(async () => {
            const drop = new Event('drop', { bubbles: true, cancelable: true });
            Object.defineProperty(drop, 'dataTransfer', { value: transfer });
            body?.dispatchEvent(drop);
        });
        expect(onImportFile).toHaveBeenCalledWith(picked);
        expect(body?.hasAttribute('data-dropping')).toBe(false);
    });
    it('refuses a name no save could carry, says why, and keeps the row open', async () => {
        const onAddFile = vi.fn();
        const host = await panel(true, { onAddFile });
        await act(async () => {
            button(host, 'New file')?.click();
        });

        const field = host.querySelector<HTMLInputElement>('.explorer-panel__new input');
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
                field,
                'my enemy!.ts',
            );
            field?.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => {
            host.querySelector('.explorer-panel__new')?.dispatchEvent(
                new Event('submit', { bubbles: true, cancelable: true }),
            );
        });

        // Let through, it would be named in every save after it, and the service refuses a save
        // naming one bad path whole.
        expect(onAddFile).not.toHaveBeenCalled();
        expect(host.querySelector('.explorer-panel__problem')?.textContent).toContain(
            'src/my enemy!.ts is not a name a file can have',
        );
        expect(host.querySelector('.explorer-panel__new')).not.toBeNull();
    });

    it('refuses to import a file whose name no save could carry', async () => {
        const onImportFile = vi.fn();
        const host = await panel(true, { onImportFile });
        const picker = host.querySelector<HTMLInputElement>('input[type="file"]');
        const picked = new File(['x'], 'my sprite (1).png', { type: 'image/png' });

        await act(async () => {
            Object.defineProperty(picker, 'files', { value: [picked], configurable: true });
            picker?.dispatchEvent(new Event('change', { bubbles: true }));
        });

        expect(onImportFile).not.toHaveBeenCalled();
        expect(host.querySelector('[role="alert"]')?.textContent).toContain('my sprite (1).png');
    });
});
