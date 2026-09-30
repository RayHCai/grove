import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { CloseIcon, FileIcon, Panel, VisuallyHidden, cx } from '@grove/ui';
import type { ProjectFile } from '../project/files';
import { CodeEditor } from './CodeEditor';
import type { EditorHandle } from './monaco';
import { useFocusFollow } from './useFocusFollow';

export interface EditorPaneProps {
    /** The open files, in tab order. */
    files: readonly ProjectFile[];
    activePath: string | null;
    onSelect: (path: string) => void;
    onClose: (path: string) => void;
    /** Hands the workbench up once Monaco is in, so the shell can compile and sync the project. */
    onReady?: ((handle: EditorHandle | null) => void) | undefined;
    className?: string | undefined;
}

const PANEL_ID = 'editor-tabpanel';

function tabId(path: string): string {
    return `tab-${path.replaceAll(/[^a-zA-Z0-9]/g, '-')}`;
}

/** The editor pane: a tab per open file, and the code editor below. */
export function EditorPane({
    files,
    activePath,
    onSelect,
    onClose,
    onReady,
    className,
}: EditorPaneProps): React.JSX.Element {
    const stripRef = useRef<HTMLDivElement>(null);
    const follow = useFocusFollow(activePath, () =>
        stripRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]'),
    );
    const active = files.find((file) => file.path === activePath) ?? null;

    function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
        if (activePath === null) return;
        const index = files.findIndex((file) => file.path === activePath);
        const move = (to: ProjectFile | undefined): void => {
            if (to === undefined) return;
            follow();
            onSelect(to.path);
        };
        switch (event.key) {
            case 'ArrowRight':
                move(files[index + 1]);
                break;
            case 'ArrowLeft':
                move(files[index - 1]);
                break;
            case 'Home':
                move(files[0]);
                break;
            case 'End':
                move(files.at(-1));
                break;
            case 'Delete':
            case 'Backspace':
                follow();
                onClose(activePath);
                break;
            default:
                return;
        }
        event.preventDefault();
    }

    return (
        <Panel
            as="section"
            aria-labelledby="editor-title"
            className={cx('pane pane--editor', className)}
        >
            <div className="pane__header">
                <VisuallyHidden as="h2" id="editor-title">
                    Editor
                </VisuallyHidden>
                <VisuallyHidden as="p" id="editor-tabs-hint">
                    Press Delete to close the open file.
                </VisuallyHidden>
                <div
                    role="tablist"
                    aria-label="Open files"
                    aria-describedby="editor-tabs-hint"
                    className="tabs"
                    ref={stripRef}
                    onKeyDown={onKeyDown}
                >
                    {files.map((file) => {
                        const selected = file.path === activePath;
                        return (
                            <div
                                key={file.path}
                                role="presentation"
                                className={cx('tab', selected && 'tab--selected')}
                            >
                                <button
                                    type="button"
                                    role="tab"
                                    id={tabId(file.path)}
                                    aria-selected={selected}
                                    aria-controls={PANEL_ID}
                                    tabIndex={selected ? 0 : -1}
                                    className="tab__button"
                                    onClick={() => onSelect(file.path)}
                                >
                                    <FileIcon size={14} />
                                    <span className="tab__name">{file.name}</span>
                                </button>
                                <button
                                    type="button"
                                    tabIndex={-1}
                                    aria-label={`Close ${file.name}`}
                                    className="tab__close"
                                    onClick={() => onClose(file.path)}
                                >
                                    <CloseIcon size={12} />
                                </button>
                            </div>
                        );
                    })}
                </div>
            </div>
            <CodeEditor
                file={active}
                {...(onReady === undefined ? {} : { onReady })}
                id={PANEL_ID}
                {...(activePath === null ? {} : { labelledBy: tabId(activePath) })}
                className="pane__body"
            />
        </Panel>
    );
}
