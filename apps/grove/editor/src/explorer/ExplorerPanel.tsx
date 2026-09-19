import { useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, Ref } from 'react';
import { Button, CloseIcon, IconButton, TextInput } from '@grove/ui';
import type { ProjectFile, ProjectNode } from '../project/files';
import { FileTree } from './FileTree';

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
    const [path, setPath] = useState('');
    const pickerRef = useRef<HTMLInputElement>(null);

    function closeOnEscape(event: KeyboardEvent<HTMLElement>): void {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        // The naming row is what Escape closes first; the panel is what is left to close.
        if (naming) {
            setNaming(false);
            setPath('');
            return;
        }
        onClose();
    }

    function create(event: FormEvent): void {
        event.preventDefault();
        onAddFile(path.trim());
        setPath('');
        setNaming(false);
    }

    return (
        <aside
            id="explorer-panel"
            aria-label="Explorer"
            className="side-panel explorer-panel"
            ref={ref}
            tabIndex={-1}
            hidden={!open}
            data-open={open}
            onKeyDown={closeOnEscape}
        >
            <div className="side-panel__head">
                <h2 className="side-panel__title">Explorer</h2>
                <IconButton label="Close" variant="ghost" size="sm" onClick={onClose}>
                    <CloseIcon />
                </IconButton>
            </div>
            <div className="explorer-panel__body">
                <p className="explorer-panel__project">{projectName}</p>
                <div className="explorer-panel__tools">
                    <Button variant="ghost" size="sm" onClick={() => setNaming(true)}>
                        New file
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => pickerRef.current?.click()}>
                        Import
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        aria-disabled={activePath === null || undefined}
                        onClick={() => {
                            if (activePath !== null) onRemoveFile(activePath);
                        }}
                    >
                        Delete
                    </Button>
                </div>
                {naming && (
                    <form className="explorer-panel__new" onSubmit={create}>
                        <TextInput
                            label="New file"
                            labelHidden
                            autoFocus
                            placeholder="src/enemy.ts"
                            value={path}
                            onChange={(event) => setPath(event.target.value)}
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
                        if (picked !== undefined) onImportFile(picked);
                        // Cleared, or picking the same file twice raises no second change event.
                        event.target.value = '';
                    }}
                />
                <FileTree nodes={nodes} activePath={activePath} onOpen={onOpenFile} />
            </div>
        </aside>
    );
}
