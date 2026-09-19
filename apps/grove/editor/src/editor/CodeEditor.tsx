import { useEffect, useId, useRef, useState } from 'react';
import { VisuallyHidden, cx, useTheme } from '@grove/ui';
import type { EditorFile, EditorHandle, MountOptions } from './monaco';

export interface CodeEditorProps {
    /** The file on screen; `null` leaves the editor empty, with nothing open. */
    file: EditorFile | null;
    className?: string | undefined;
    id?: string | undefined;
    /** The tab naming this body; without it the body is a region named Code. */
    labelledBy?: string | undefined;
    /** Hands the workbench out once Monaco is in, and hands null back when it goes. */
    onReady?: ((handle: EditorHandle | null) => void) | undefined;
}

interface Boundary {
    mountEditor(host: HTMLElement, options: MountOptions): EditorHandle;
}

let boundary: Promise<Boundary> | undefined;

// One in-flight load serves every mount, so StrictMode's paired effects never race two imports.
function loadBoundary(): Promise<Boundary> {
    boundary ??= import('./monaco').catch((error: unknown) => {
        // A failed chunk must not stay cached, or a later mount could never try again.
        boundary = undefined;
        throw error;
    });
    return boundary;
}

/** The Monaco host region; Monaco arrives lazily and only through `./monaco`. */
export function CodeEditor({
    file,
    className,
    id,
    labelledBy,
    onReady,
}: CodeEditorProps): React.JSX.Element {
    const { theme } = useTheme();
    const hostRef = useRef<HTMLDivElement>(null);
    const handleRef = useRef<EditorHandle | null>(null);
    const [handle, setHandle] = useState<EditorHandle | null>(null);
    const [failed, setFailed] = useState(false);
    const keysId = useId();
    // The mount takes the first file through its options, so the open effect must not repeat it.
    const openedRef = useRef<string | null>(file?.path ?? null);
    // Read through a ref, so the mount effect never has to re-run over a caller passing a new
    // function every render.
    const readyRef = useRef(onReady);
    readyRef.current = onReady;

    useEffect(() => {
        const host = hostRef.current;
        if (host === null) return undefined;
        // StrictMode runs this effect twice; the flag keeps the abandoned first run from mounting.
        let cancelled = false;
        loadBoundary()
            .then((loaded) => {
                if (cancelled) return;
                const mounted = loaded.mountEditor(host, { file, theme });
                handleRef.current = mounted;
                setHandle(mounted);
                readyRef.current?.(mounted);
            })
            .catch(() => {
                if (!cancelled) setFailed(true);
            });
        return () => {
            cancelled = true;
            handleRef.current?.dispose();
            handleRef.current = null;
            readyRef.current?.(null);
        };
    }, []);

    useEffect(() => {
        handle?.setTheme(theme);
    }, [handle, theme]);

    useEffect(() => {
        if (handle === null) return;
        const path = file?.path ?? null;
        if (openedRef.current === path) return;
        openedRef.current = path;
        handle.openFile(file);
    }, [handle, file]);

    const loading = handle === null && !failed;
    const naming =
        labelledBy === undefined
            ? ({ role: 'region', 'aria-label': 'Code' } as const)
            : ({ role: 'tabpanel', 'aria-labelledby': labelledBy } as const);

    return (
        <div
            {...naming}
            id={id}
            className={cx('editor-body', className)}
            aria-describedby={keysId}
            aria-busy={loading}
        >
            <VisuallyHidden as="p" id={keysId}>
                Press Ctrl+M (Ctrl+Shift+M on a Mac), then Tab, to leave the code editor.
            </VisuallyHidden>
            <div className="editor-host" ref={hostRef} />
            {loading && (
                <p className="editor-status" role="status">
                    Loading editor…
                </p>
            )}
            {failed && (
                <p className="editor-status" role="alert">
                    The editor could not load. Reload the page to try again.
                </p>
            )}
            {!loading && !failed && file === null && (
                <p className="editor-status">Pick a file in the Explorer to start editing.</p>
            )}
        </div>
    );
}
