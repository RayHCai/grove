import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ChevronRightIcon, FileIcon, FolderIcon, cx } from '@grove/ui';
import { folderPaths } from '../project/files';
import type { ProjectFile, ProjectNode } from '../project/files';

export interface FileTreeProps {
    nodes: readonly ProjectNode[];
    activePath: string | null;
    onOpen: (file: ProjectFile) => void;
}

interface Row {
    node: ProjectNode;
    level: number;
    parent: string | null;
}

/** The rows the tree actually renders: a collapsed folder hides its subtree from the arrow keys too. */
function rows(
    nodes: readonly ProjectNode[],
    expanded: ReadonlySet<string>,
    level = 1,
    parent: string | null = null,
): Row[] {
    return nodes.flatMap((node) => {
        const row: Row = { node, level, parent };
        if (node.kind === 'folder' && expanded.has(node.path)) {
            return [row, ...rows(node.children, expanded, level + 1, node.path)];
        }
        return [row];
    });
}

/** The project's files as an ARIA tree: folders disclose, files open in the editor. */
export function FileTree({ nodes, activePath, onOpen }: FileTreeProps): React.JSX.Element {
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(
        () => new Set(folderPaths(nodes)),
    );
    const [focusedPath, setFocusedPath] = useState<string | null>(null);
    const itemRefs = useRef(new Map<string, HTMLLIElement>());
    // Only the keys that move focus set this, so a click never pulls focus back off the pointer.
    const restoreFocus = useRef(false);

    const visible = rows(nodes, expanded);
    const firstPath = visible[0]?.node.path ?? null;
    const tabbable = visible.some((row) => row.node.path === focusedPath) ? focusedPath : firstPath;

    useEffect(() => {
        if (!restoreFocus.current || focusedPath === null) return;
        restoreFocus.current = false;
        itemRefs.current.get(focusedPath)?.focus();
    }, [focusedPath]);

    const toggle = useCallback((path: string) => {
        setExpanded((current) => {
            const next = new Set(current);
            if (!next.delete(path)) next.add(path);
            return next;
        });
    }, []);

    function activate(node: ProjectNode): void {
        if (node.kind === 'folder') toggle(node.path);
        else onOpen(node);
    }

    function move(to: string | undefined): void {
        if (to === undefined) return;
        restoreFocus.current = true;
        setFocusedPath(to);
    }

    function onKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
        if (tabbable === null) return;
        const index = visible.findIndex((row) => row.node.path === tabbable);
        const row = visible[index];
        if (row === undefined) return;
        const { node } = row;
        const open = node.kind === 'folder' && expanded.has(node.path);

        switch (event.key) {
            case 'ArrowDown':
                move(visible[index + 1]?.node.path);
                break;
            case 'ArrowUp':
                move(visible[index - 1]?.node.path);
                break;
            case 'ArrowRight':
                if (node.kind !== 'folder') return;
                if (open) move(visible[index + 1]?.node.path);
                else toggle(node.path);
                break;
            case 'ArrowLeft':
                if (open) toggle(node.path);
                else move(row.parent ?? undefined);
                break;
            case 'Home':
                move(visible[0]?.node.path);
                break;
            case 'End':
                move(visible.at(-1)?.node.path);
                break;
            case 'Enter':
            case ' ':
                activate(node);
                break;
            default:
                return;
        }
        event.preventDefault();
    }

    function renderNodes(list: readonly ProjectNode[], level: number): React.JSX.Element[] {
        return list.map((node) => {
            const folder = node.kind === 'folder';
            const open = folder && expanded.has(node.path);
            const selected = !folder && node.path === activePath;
            return (
                <li
                    key={node.path}
                    role="treeitem"
                    aria-level={level}
                    aria-selected={selected}
                    {...(folder ? { 'aria-expanded': open } : {})}
                    tabIndex={node.path === tabbable ? 0 : -1}
                    ref={(element) => {
                        if (element === null) itemRefs.current.delete(node.path);
                        else itemRefs.current.set(node.path, element);
                    }}
                    className={cx('tree__item', selected && 'tree__item--selected')}
                    onClick={(event) => {
                        event.stopPropagation();
                        setFocusedPath(node.path);
                        activate(node);
                    }}
                >
                    <span
                        className="tree__row"
                        style={{ paddingLeft: `${(level - 1) * 12 + 8}px` }}
                    >
                        {folder ? (
                            <ChevronRightIcon size={12} className="tree__twisty" />
                        ) : (
                            <span className="tree__twisty" />
                        )}
                        {folder ? <FolderIcon size={14} /> : <FileIcon size={14} />}
                        <span className="tree__name">{node.name}</span>
                    </span>
                    {folder && open && (
                        <ul role="group" className="tree__group">
                            {renderNodes(node.children, level + 1)}
                        </ul>
                    )}
                </li>
            );
        });
    }

    return (
        <ul role="tree" aria-label="Files" className="tree" onKeyDown={onKeyDown}>
            {renderNodes(nodes, 1)}
        </ul>
    );
}
