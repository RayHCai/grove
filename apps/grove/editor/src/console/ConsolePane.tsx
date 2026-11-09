import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Button, Panel, TerminalIcon, cx } from '@grove/ui';
import type { ConsoleLines } from './lines';

export interface ConsolePaneProps {
    /** The only subscriber the lines have, so a run that logs every tick redraws this pane alone. */
    lines: ConsoleLines;
    className?: string | undefined;
}

/** The console: what a local run wrote, oldest first, and a button to forget it. */
export function ConsolePane({ lines, className }: ConsolePaneProps): React.JSX.Element {
    const shown = useSyncExternalStore(lines.subscribe, lines.snapshot);
    const bodyRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const body = bodyRef.current;
        if (body === null) return;
        // Pinned to the newest line, which is the one a creator pressed Play to see.
        body.scrollTop = body.scrollHeight;
    }, [shown]);

    return (
        <Panel
            as="section"
            aria-labelledby="console-title"
            className={cx('pane pane--console', className)}
        >
            <div className="pane__header">
                <span className="console-icon">
                    <TerminalIcon size={14} />
                </span>
                <h2 id="console-title" className="pane__title">
                    Console
                </h2>
                <Button
                    variant="ghost"
                    size="sm"
                    cursor={false}
                    className="console-clear"
                    aria-disabled={shown.length === 0 || undefined}
                    onClick={() => lines.clear()}
                >
                    Clear
                </Button>
            </div>
            <div className="console-body" role="log" aria-label="Console output" ref={bodyRef}>
                {shown.map((line) => (
                    <p key={line.id} className={`console-line console-line--${line.level}`}>
                        {line.text}
                    </p>
                ))}
            </div>
        </Panel>
    );
}
