import type { Ref } from 'react';
import { IconButton, Panel, SendIcon, SparkIcon, TextArea } from '@grove/ui';
import { SidePanel } from './SidePanel';

export interface AiPanelProps {
    open: boolean;
    /** Runs on the close button and on Escape inside the panel; the caller returns focus. */
    onClose: () => void;
    ref?: Ref<HTMLElement> | undefined;
}

/** The Grove AI panel: a header, the thread and a composer, kept mounted and hidden while closed. */
export function AiPanel({ open, onClose, ref }: AiPanelProps): React.JSX.Element {
    return (
        <SidePanel
            id="grove-ai-panel"
            label="Grove AI"
            title="Grove AI"
            className="ai-panel"
            open={open}
            onClose={onClose}
            ref={ref}
            mark={
                <span className="ai-panel__mark">
                    <SparkIcon />
                </span>
            }
        >
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
        </SidePanel>
    );
}
