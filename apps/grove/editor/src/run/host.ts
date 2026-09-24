import { runDocument, windowDocument } from './document';

/**
 * The module a sandboxed run starts from.
 *
 * A game the engine drives has no entry at all — the manifest names its scripts and the world
 * instantiates them — so this is what a plain TypeScript project is run through, and nothing else.
 */
export const RUN_ENTRY = 'src/main.ts';

export type LogLevel = 'log' | 'warn' | 'error';

/** One line the console pane prints, in the order the run produced it. */
export interface RunLine {
    id: number;
    level: LogLevel;
    text: string;
}

/** Where a run is showing: on the play pane's stage, or in a window of its own. */
export type Surface = 'stage' | 'window';

export interface RunEvents {
    onLine(line: Omit<RunLine, 'id'>): void;
}

const TO_FRAME = 'grove-editor';
const FROM_FRAME = 'grove-run';

interface FrameMessage {
    source?: unknown;
    type?: unknown;
    level?: unknown;
    text?: unknown;
}

/**
 * The editor's side of a local run.
 *
 * It owns the frame's document and the channel to it, and nothing else: the run itself is entirely
 * inside a sandbox with an origin of its own, which is why every exchange here is a `postMessage`
 * and why a message is believed only when it came from a window this host opened.
 */
export class RunHost {
    readonly #events: RunEvents;
    #frame: HTMLIFrameElement | null = null;
    #opened: Window | null = null;
    #surface: Surface = 'stage';
    #document: string | undefined;

    constructor(events: RunEvents) {
        this.#events = events;
        window.addEventListener('message', this.#receive);
    }

    /** The stage's frame, handed over once the play pane has one. */
    attach(frame: HTMLIFrameElement | null): void {
        this.#frame = frame;
    }

    get surface(): Surface {
        return this.#surface;
    }

    /**
     * Starts a run of these modules on `surface`, replacing whatever was running.
     *
     * A run is a fresh document every time. There is no way to re-enter a module graph that has
     * already been evaluated, and a Play button that resumed one would be lying about what it did.
     */
    start(
        modules: Record<string, string>,
        entry: string,
        title: string,
        colors: { background: string; foreground: string },
        surface: Surface = 'stage',
    ): void {
        this.stop();
        this.#document = runDocument({ modules, entry, title, ...colors });
        this.#surface = surface;
        if (surface === 'window') {
            this.#openWindow(title);
        } else if (this.#frame !== null) {
            this.#frame.srcdoc = this.#document;
        }
    }

    pause(): void {
        this.#send('pause');
    }

    resume(): void {
        this.#send('resume');
    }

    /** Tears the run down. Dropping the document is what ends it: nothing in there is asked nicely. */
    stop(): void {
        if (this.#frame !== null) this.#frame.removeAttribute('srcdoc');
        this.#opened?.close();
        this.#opened = null;
    }

    dispose(): void {
        this.stop();
        window.removeEventListener('message', this.#receive);
    }

    #openWindow(title: string): void {
        const opened = window.open('', '_blank', 'noopener=no');
        if (opened === null || this.#document === undefined) {
            this.#events.onLine({
                level: 'error',
                text: 'the browser blocked the run window; allow pop-ups for this page',
            });
            this.#surface = 'stage';
            return;
        }
        opened.document.write(windowDocument(this.#document, title));
        opened.document.close();
        this.#opened = opened;
    }

    #send(type: 'pause' | 'resume'): void {
        const target = this.#surface === 'window' ? this.#opened : this.#frame?.contentWindow;
        target?.postMessage({ source: TO_FRAME, type }, '*');
    }

    // A field rather than a method, so the listener removed at dispose is the one that was added.
    readonly #receive = (event: MessageEvent<FrameMessage>): void => {
        // The frame has an origin of its own, so `event.origin` is "null" for every run and proves
        // nothing. What a message is believed on is the window it came from being one of ours.
        const known =
            event.source !== null &&
            (event.source === this.#frame?.contentWindow || event.source === this.#opened);
        if (!known || event.data.source !== FROM_FRAME) return;

        if (event.data.type === 'log') {
            const level = event.data.level;
            this.#events.onLine({
                level: level === 'warn' || level === 'error' ? level : 'log',
                text: String(event.data.text),
            });
        }
        if (event.data.type === 'error') {
            this.#events.onLine({ level: 'error', text: String(event.data.text) });
        }
    };
}
