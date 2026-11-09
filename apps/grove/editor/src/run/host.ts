import { PREVIEW_DOCUMENTS } from 'virtual:grove-preview';
import { CHANNEL, RUN_PARAM, fromFrame } from './protocol';
import type { Game, LogLevel, StageStatus, ToFrame } from './protocol';

/** The module a plain run starts from; a world has no entry, since its manifest names its scripts. */
export const RUN_ENTRY = 'src/main.ts';

export interface RunEvents {
    onLine(level: LogLevel, text: string): void;
    onStatus(status: StageStatus): void;
}

/** Where each kind of run's document is served from, which a build names and a test hands in. */
export type PreviewDocuments = Readonly<Record<Game['mode'], string>>;

/**
 * The editor's side of a run.
 *
 * It owns the frame's document and the channel to it, and nothing else: the run itself is entirely
 * inside a sandbox with an origin of its own, which is why every exchange here is a `postMessage`
 * and why a message is believed only when it came from the frame this host filled.
 */
export class PreviewHost {
    readonly #events: RunEvents;
    readonly #documents: PreviewDocuments;
    #frame: HTMLIFrameElement | null = null;
    /** The run on stage, which its document names in every message it sends. */
    #run: string | undefined;
    /** Posted once the document says it is listening; a message sent before that is lost. */
    #pending: Game | undefined;

    constructor(events: RunEvents, documents: PreviewDocuments = PREVIEW_DOCUMENTS) {
        this.#events = events;
        this.#documents = documents;
        window.addEventListener('message', this.#receive);
    }

    /** The stage's frame, handed over once the play pane has one. */
    attach(frame: HTMLIFrameElement | null): void {
        this.#frame = frame;
    }

    /** A fresh document for every run, since a module graph that has evaluated cannot be re-entered. */
    start(game: Game): void {
        this.stop();
        if (this.#frame === null) return;
        const run = crypto.randomUUID();
        const url = new URL(this.#documents[game.mode], window.location.href);
        // A query rather than a fragment: a fragment alone would scroll the old document, not load one.
        url.searchParams.set(RUN_PARAM, run);
        this.#run = run;
        this.#pending = game;
        this.#frame.src = url.href;
    }

    pause(): void {
        this.#send({ type: 'pause' });
    }

    resume(): void {
        this.#send({ type: 'resume' });
    }

    /** Tears the run down. Dropping the document is what ends it: nothing in there is asked nicely. */
    stop(): void {
        this.#run = undefined;
        this.#pending = undefined;
        if (this.#frame?.hasAttribute('src') === true) this.#frame.src = 'about:blank';
    }

    dispose(): void {
        this.stop();
        window.removeEventListener('message', this.#receive);
    }

    #send(message: ToFrame): void {
        const target = this.#frame?.contentWindow;
        if (target === null || target === undefined || this.#run === undefined) return;
        // The frame's origin is opaque, so `*` is the only target that names it.
        target.postMessage({ ...message, channel: CHANNEL, run: this.#run }, '*');
    }

    // A field rather than a method, so the listener removed at dispose is the one that was added.
    readonly #receive = (event: MessageEvent<unknown>): void => {
        // `event.origin` is "null" for every run and proves nothing; what a message is believed on
        // is the window it came from being this frame's, and the run it names being this one.
        const frame = this.#frame?.contentWindow ?? null;
        if (frame === null || event.source !== frame || this.#run === undefined) return;
        const message = fromFrame(event.data, this.#run);
        if (message === undefined) return;

        if (message.type === 'ready') {
            const game = this.#pending;
            this.#pending = undefined;
            if (game !== undefined) this.#send({ type: 'run', game });
        } else if (message.type === 'line') {
            this.#events.onLine(message.level, message.text);
        } else {
            this.#events.onStatus(message.status);
        }
    };
}
