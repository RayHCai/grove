import { Button, IconButton, PauseIcon, PlayIcon, StopIcon, cx } from '@grove/ui';

export type TransportState = 'idle' | 'playing' | 'paused';
export type TransportAction = 'play' | 'pause' | 'stop';

export interface TransportProps {
    state: TransportState;
    dispatch: (action: TransportAction) => void;
    className?: string | undefined;
}

/** Play starts or resumes, pause holds a running game, stop returns to idle from anywhere. */
export function transportReducer(state: TransportState, action: TransportAction): TransportState {
    if (action === 'stop') return 'idle';
    if (action === 'play') return 'playing';
    return state === 'playing' ? 'paused' : state;
}

/** The run controls: one Play/Pause button and a Stop that is inert while idle. */
export function Transport({ state, dispatch, className }: TransportProps): React.JSX.Element {
    const playing = state === 'playing';
    return (
        <div role="group" aria-label="Run controls" className={cx('transport', className)}>
            <Button
                variant="primary"
                size="sm"
                className="transport__play"
                icon={playing ? <PauseIcon /> : <PlayIcon />}
                onClick={() => dispatch(playing ? 'pause' : 'play')}
            >
                {playing ? 'Pause' : 'Play'}
            </Button>
            <IconButton
                label="Stop"
                variant="ghost"
                size="sm"
                aria-disabled={state === 'idle' ? 'true' : undefined}
                onClick={() => dispatch('stop')}
            >
                <StopIcon />
            </IconButton>
        </div>
    );
}
