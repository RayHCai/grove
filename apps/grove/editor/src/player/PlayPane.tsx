import { useRef, useSyncExternalStore } from 'react';
import type { Ref } from 'react';
import {
    Button,
    IconButton,
    MaximizeIcon,
    MinimizeIcon,
    Panel,
    VisuallyHidden,
    cx,
} from '@grove/ui';
import { Transport } from '../shell/Transport';
import type { TransportAction, TransportState } from '../shell/Transport';

export interface PlayPaneProps {
    status: TransportState;
    dispatch: (action: TransportAction) => void;
    /** Reaches the frame a local run is written into; the run host owns what goes in it. */
    frameRef?: Ref<HTMLIFrameElement> | undefined;
    /** Starts the same run in a window of its own, at whatever size the creator gives it. */
    onOpenWindow?: (() => void) | undefined;
    className?: string | undefined;
}

const statusText: Record<TransportState, string> = {
    idle: 'Idle',
    playing: 'Running',
    paused: 'Paused',
};

function subscribeFullscreen(onChange: () => void): () => void {
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
}

function neverFullscreen(): boolean {
    return false;
}

/** The game preview: run controls and status over a 16:9 stage holding the frame and its buttons. */
export function PlayPane({
    status,
    dispatch,
    frameRef,
    onOpenWindow,
    className,
}: PlayPaneProps): React.JSX.Element {
    const stageRef = useRef<HTMLDivElement>(null);
    const fullscreen = useSyncExternalStore(
        subscribeFullscreen,
        () => {
            const stage = stageRef.current;
            return stage !== null && document.fullscreenElement === stage;
        },
        neverFullscreen,
    );

    function toggleFullscreen(): void {
        const stage = stageRef.current;
        if (fullscreen) {
            if (typeof document.exitFullscreen === 'function') {
                void document.exitFullscreen().catch(() => undefined);
            }
        } else if (stage !== null && typeof stage.requestFullscreen === 'function') {
            void stage.requestFullscreen().catch(() => undefined);
        }
    }

    return (
        <Panel
            as="section"
            aria-labelledby="play-title"
            className={cx('pane pane--play', className)}
        >
            <div className="pane__header">
                <VisuallyHidden as="h2" id="play-title">
                    Play
                </VisuallyHidden>
                <Transport state={status} dispatch={dispatch} />
                <span role="status" className={`play-status play-status--${status}`}>
                    {statusText[status]}
                </span>
                {onOpenWindow !== undefined && (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="play-popout"
                        onClick={onOpenWindow}
                    >
                        Full page
                    </Button>
                )}
            </div>
            <div ref={stageRef} className="play-stage">
                {/* A frame with no src is still a tab stop; a loaded game restores its own focusability. */}
                <iframe
                    ref={frameRef}
                    className="play-frame"
                    title="Game preview"
                    sandbox="allow-scripts"
                    tabIndex={-1}
                />
                <IconButton
                    size="sm"
                    className="play-fullscreen"
                    label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                    onClick={toggleFullscreen}
                >
                    {fullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
                </IconButton>
            </div>
        </Panel>
    );
}
