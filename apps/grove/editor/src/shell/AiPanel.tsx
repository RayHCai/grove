import type { KeyboardEvent, Ref } from 'react';
import { CloseIcon, IconButton, Panel, SendIcon, SparkIcon, TextArea } from '@grove/ui';

export interface AiPanelProps {
    open: boolean;
    /** Runs on the close button and on Escape inside the panel; the caller returns focus. */
    onClose: () => void;
    ref?: Ref<HTMLElement> | undefined;
}

/** The Grove AI panel: a header, the thread and a composer, kept mounted and hidden while closed. */
export function AiPanel({ open, onClose, ref }: AiPanelProps): React.JSX.Element {
    function closeOnEscape(event: KeyboardEvent<HTMLElement>): void {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
    }
    return (
        <aside
            id="grove-ai-panel"
            aria-label="Grove AI"
            className="side-panel ai-panel"
            ref={ref}
            tabIndex={-1}
            hidden={!open}
            data-open={open}
            onKeyDown={closeOnEscape}
        >
            <div className="side-panel__head">
                <span className="ai-panel__mark">
                    <SparkIcon />
                </span>
                <h2 className="side-panel__title">Grove AI</h2>
                <IconButton label="Close" size="sm" variant="ghost" onClick={onClose}>
                    <CloseIcon />
                </IconButton>
            </div>
            <div className="ai-panel__thread">
                <Panel face="accent" className="ai-panel__note">
                    <p>I&rsquo;ll help you grow your game. Chat is coming soon.</p>
                </Panel>
            </div>
            <div className="ai-panel__composer">
                <TextArea
                    label="Message Grove AI"
                    labelHidden
                    readOnly
                    rows={3}
                    aria-describedby="ai-status"
                    placeholder="Chat is coming soon"
                />
                <div className="ai-panel__foot">
                    <p id="ai-status" className="ai-panel__status">
                        Grove AI · not connected yet
                    </p>
                    <IconButton
                        label="Send"
                        size="sm"
                        variant="primary"
                        aria-disabled="true"
                        aria-describedby="ai-status"
                    >
                        <SendIcon />
                    </IconButton>
                </div>
            </div>
        </aside>
    );
}
