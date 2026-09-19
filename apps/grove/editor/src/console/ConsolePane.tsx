import { useEffect, useRef } from 'react';
import { Button, Panel, TerminalIcon, cx } from '@grove/ui';
import type { RunLine } from '../run/host';

export interface ConsolePaneProps {
    lines: readonly RunLine[];
    onClear: () => void;
    className?: string | undefined;
}

/** The console: what a local run wrote, oldest first, and a button to forget it. */
export function ConsolePane({ lines, onClear, className }: ConsolePaneProps): React.JSX.Element {
    const bodyRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const body = bodyRef.current;
        if (body === null) return;
        // Pinned to the newest line, which is the one a creator pressed Play to see.
        body.scrollTop = body.scrollHeight;
    }, [lines]);

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
                    className="console-clear"
                    aria-disabled={lines.length === 0 || undefined}
                    onClick={onClear}
                >
                    Clear
                </Button>
            </div>
            <div className="console-body" role="log" aria-label="Console output" ref={bodyRef}>
                {lines.map((line) => (
                    <p key={line.id} className={`console-line console-line--${line.level}`}>
                        {line.text}
                    </p>
                ))}
            </div>
        </Panel>
    );
}
