import type { LogLevel } from '../run/protocol';

/** What the console keeps. A game in a loop writes faster than anyone reads. */
export const MAX_LINES = 500;

/** One line the console pane prints, in the order the run produced it. */
export interface ConsoleLine {
    id: number;
    level: LogLevel;
    text: string;
}

/** How a flush is put off to the next frame; a test hands in one it turns by hand. */
export type Schedule = (flush: () => void) => void;

function nextFrame(flush: () => void): void {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => flush());
    else setTimeout(flush, 16);
}

/** The lines outside React, so a game logging every tick redraws the pane alone, once a frame. */
export class ConsoleLines {
    readonly #ring: (ConsoleLine | undefined)[] = Array.from({ length: MAX_LINES });
    readonly #listeners = new Set<() => void>();
    readonly #schedule: Schedule;
    #start = 0;
    #count = 0;
    #id = 0;
    #shown: readonly ConsoleLine[] = [];
    #due = false;

    constructor(schedule: Schedule = nextFrame) {
        this.#schedule = schedule;
    }

    write(level: LogLevel, text: string): void {
        this.#id += 1;
        this.#ring[(this.#start + this.#count) % MAX_LINES] = { id: this.#id, level, text };
        if (this.#count < MAX_LINES) this.#count += 1;
        else this.#start = (this.#start + 1) % MAX_LINES;
        this.#request();
    }

    clear(): void {
        this.#ring.fill(undefined);
        this.#start = 0;
        this.#count = 0;
        this.#request();
    }

    /** For `useSyncExternalStore`, which needs the same function every render. */
    readonly subscribe = (listener: () => void): (() => void) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    };

    /** What the pane shows, oldest first; the same array until the next flush. */
    readonly snapshot = (): readonly ConsoleLine[] => this.#shown;

    #request(): void {
        if (this.#due) return;
        this.#due = true;
        this.#schedule(() => this.#flush());
    }

    #flush(): void {
        this.#due = false;
        const shown: ConsoleLine[] = [];
        for (let at = 0; at < this.#count; at += 1) {
            const line = this.#ring[(this.#start + at) % MAX_LINES];
            if (line !== undefined) shown.push(line);
        }
        this.#shown = shown;
        for (const listener of this.#listeners) listener();
    }
}
