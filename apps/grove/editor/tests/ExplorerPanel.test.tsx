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
});
