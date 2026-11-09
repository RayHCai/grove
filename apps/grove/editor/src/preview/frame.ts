// The run's document end of the channel: the run it was opened for, and the window that opened it.

import { CHANNEL, RUN_PARAM, toFrame } from '../run/protocol';
import type { FromFrame, Game, LogLevel, StageStatus } from '../run/protocol';
import type { ConsoleSink } from './link';
import { renderLine } from './render';

/** What a running game reaches the editor through. */
export interface Stage {
    line(level: LogLevel, text: string): void;
    status(status: StageStatus): void;
    /** What Pause and Resume reach, once the run has a clock to stop. */
    controls(controls: { pause(): void; resume(): void }): void;
    /** The `console` the run's own code is handed. */
    readonly console: ConsoleSink;
}

/** A failure as the console prints it: a link error is a sentence, and anything else its stack. */
function describe(failure: unknown): string {
    return failure instanceof Error && failure.name === 'LinkError'
        ? failure.message
        : renderLine([failure]);
}

/** Opens the document's end and starts the first run the editor hands it, and only that one. */
export function openStage(
    start: (game: Game, stage: Stage) => Promise<void>,
    scope: Window = window,
): void {
    const run = new URL(scope.location.href).searchParams.get(RUN_PARAM) ?? '';
    const post = (message: FromFrame): void => {
        // The editor's origin is not this document's to know, and nothing here is a secret.
        scope.parent.postMessage({ ...message, channel: CHANNEL, run }, '*');
    };
    const say =
        (level: LogLevel) =>
        (...values: unknown[]): void =>
            post({ type: 'line', level, text: renderLine(values) });

    let controls: { pause(): void; resume(): void } | undefined;
    let started = false;
    const stage: Stage = {
        line: (level, text) => post({ type: 'line', level, text }),
        status: (status) => post({ type: 'status', status }),
        controls: (next) => {
            controls = next;
        },
        console: { log: say('log'), info: say('log'), warn: say('warn'), error: say('error') },
    };

    scope.addEventListener('message', (event: MessageEvent<unknown>) => {
        // The editor is this document's parent, and nothing else is: the run's own code included.
        if (event.source !== scope.parent) return;
        const message = toFrame(event.data, run);
        if (message?.type === 'pause') controls?.pause();
        if (message?.type === 'resume') controls?.resume();
        if (message?.type !== 'run' || started) return;
        started = true;
        stage.status('starting');
        start(message.game, stage).catch((failure: unknown) => {
            stage.line('error', describe(failure));
            stage.status('failed');
        });
    });
    scope.addEventListener('error', (event: ErrorEvent) => {
        stage.line('error', `${event.message} (${String(event.lineno)})`);
    });
    scope.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
        stage.line('error', `unhandled rejection: ${describe(event.reason)}`);
    });

    post({ type: 'ready' });
}
