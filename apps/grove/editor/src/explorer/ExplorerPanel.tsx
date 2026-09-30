import { useRef, useState } from 'react';
import type { DragEvent, FormEvent, Ref } from 'react';
import { IconButton, Menu, MenuItem, NewFileIcon, TextInput, UploadIcon } from '@grove/ui';
import { WorkspacePath } from '@grove/api-contract';
import { filesUnder, sourcePath } from '../project/files';
import { SidePanel } from '../shell/SidePanel';
import type { ProjectFile, ProjectNode } from '../project/files';
import { FileTree } from './FileTree';
import type { MenuAt } from './FileTree';

export interface ExplorerPanelProps {
    open: boolean;
    /** What the game is called, which is what the tree hangs under. */
    projectName: string;
    nodes: readonly ProjectNode[];
    activePath: string | null;
    onOpenFile: (file: ProjectFile) => void;
    onAddFile: (path: string) => void;
    /** A file picked off the creator's machine: art, audio, anything the game carries. */
    onImportFile: (file: File) => void;
    onRemoveFile: (path: string) => void;
    /** Runs on the close button and on Escape inside the panel; the caller returns focus. */
    onClose: () => void;
    ref?: Ref<HTMLElement> | undefined;
}

interface RowMenu {
    node: ProjectNode;
    at: MenuAt;
    /** Where focus was when the menu opened, which is where Escape hands it back. */
    opener: HTMLElement | null;
}

/**
 * Why a name cannot be a file in this game, or nothing when it can.
 *
 * Checked here rather than left to the service: a save naming one bad path is refused whole, so a
 * name let through would wedge every save after it.
 */
function problemWith(path: string): string | undefined {
    const checked = WorkspacePath.safeParse(path);
    return checked.success
        ? undefined
        : `${path} is not a name a file can have: use letters, digits, dot, dash and underscore.`;
}

/** Whether a drag is carrying files off the machine rather than something from this page. */
function carriesFiles(event: DragEvent): boolean {
    return event.dataTransfer.types.includes('Files');
}

/** The file explorer: the game's folders and files, kept mounted and hidden while closed. */
export function ExplorerPanel({
    open,
    projectName,
    nodes,
    activePath,
    onOpenFile,
    onAddFile,
    onImportFile,
    onRemoveFile,
    onClose,
    ref,
}: ExplorerPanelProps): React.JSX.Element {
    const [naming, setNaming] = useState(false);
    const [name, setName] = useState('');
    const [menu, setMenu] = useState<RowMenu | null>(null);
    const [dropping, setDropping] = useState(false);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const pickerRef = useRef<HTMLInputElement>(null);

    // The menu takes its own Escape; the naming row is next, and the panel is what is left to close.
    function escapeInside(): boolean {
        if (naming) {
            setNaming(false);
            setName('');
            return true;
        }
        return false;
    }

    function create(event: FormEvent): void {
        event.preventDefault();
        const typed = name.trim();
        if (typed !== '') {
            const path = sourcePath(typed);
            const refused = problemWith(path);
            setProblem(refused);
            if (refused !== undefined) return;
            onAddFile(path);
        }
        setName('');
        setNaming(false);
    }

    function importFile(picked: File): void {
        const refused = problemWith(picked.name);
        setProblem(refused);
        if (refused === undefined) onImportFile(picked);
    }

    function remove(node: ProjectNode): void {
        for (const file of filesUnder(node)) onRemoveFile(file.path);
        setMenu(null);
    }

    function drop(event: DragEvent<HTMLDivElement>): void {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDropping(false);
        for (const picked of event.dataTransfer.files) importFile(picked);
    }

    return (
        <SidePanel
            id="explorer-panel"
            label="Explorer"
            title="Explorer"
            className="explorer-panel"
            open={open}
            onClose={onClose}
            onEscape={escapeInside}
            ref={ref}
        >
            <div
                className="explorer-panel__body"
                data-dropping={dropping || undefined}
                onDragOver={(event) => {
                    if (!carriesFiles(event)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'copy';
                    setDropping(true);
                }}
                onDragLeave={(event) => {
                    // Crossing onto a row inside the panel is not leaving it.
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                        setDropping(false);
                    }
                }}
                onDrop={drop}
            >
                <div className="explorer-panel__project">
                    <p className="explorer-panel__name">{projectName}</p>
                    <div className="explorer-panel__actions">
                        <IconButton
                            label="New file"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                                setProblem(undefined);
                                setNaming(true);
                            }}
                        >
                            <NewFileIcon />
                        </IconButton>
                        <IconButton
                            label="Import file"
                            variant="ghost"
                            size="sm"
                            onClick={() => pickerRef.current?.click()}
                        >
                            <UploadIcon />
                        </IconButton>
                    </div>
                </div>
                {naming && (
                    <form className="explorer-panel__new" onSubmit={create}>
                        <TextInput
                            label="New file"
                            labelHidden
                            dense
                            autoFocus
                            placeholder="enemy.ts"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            onBlur={() => {
                                setNaming(false);
                                setName('');
                            }}
                        />
                    </form>
                )}
                <input
                    ref={pickerRef}
                    type="file"
                    className="pg-visually-hidden"
                    aria-hidden="true"
                    tabIndex={-1}
                    onChange={(event) => {
                        const picked = event.target.files?.[0];
                        if (picked !== undefined) importFile(picked);
                        // Cleared, or picking the same file twice raises no second change event.
                        event.target.value = '';
                    }}
                />
                {problem !== undefined && (
                    <p className="explorer-panel__problem" role="alert">
                        {problem}
                    </p>
                )}
                <FileTree
                    nodes={nodes}
                    activePath={activePath}
                    onOpen={onOpenFile}
                    onMenu={(node, at) =>
                        setMenu({
                            node,
                            at,
                            opener:
                                document.activeElement instanceof HTMLElement
                                    ? document.activeElement
                                    : null,
                        })
                    }
                />
            </div>
            {menu !== null && (
                <Menu
                    open
                    label={menu.node.name}
                    className="explorer-menu"
                    style={{ left: `${String(menu.at.x)}px`, top: `${String(menu.at.y)}px` }}
                    onClose={(reason) => {
                        setMenu(null);
                        if (reason === 'escape') menu.opener?.focus();
                    }}
                >
                    <MenuItem onClick={() => remove(menu.node)}>Delete</MenuItem>
                </Menu>
            )}
        </SidePanel>
    );
}
