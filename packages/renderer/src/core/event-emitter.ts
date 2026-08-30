// Pure pub/sub over an event map. No scene knowledge, so `renderer-core.ts` composes one rather
// than growing a second responsibility.

/** Typed fan-out to zero or more handlers per event name. */
export class EventEmitter<Events> {
    // `never` erases the payload so one map can hold handlers for every event name; each `on`/`emit`
    // pair re-narrows at the call site, where the key is known.
    readonly #listeners = new Map<keyof Events, Set<(e: never) => void>>();

    /** Subscribes, and returns the unsubscribe. Calling it twice is harmless. */
    on<K extends keyof Events>(event: K, handler: (e: Events[K]) => void): () => void {
        let set = this.#listeners.get(event);
        if (set === undefined) {
            set = new Set();
            this.#listeners.set(event, set);
        }
        const erased = handler as (e: never) => void;
        set.add(erased);
        return () => {
            set?.delete(erased);
        };
    }

    emit<K extends keyof Events>(event: K, payload: Events[K]): void {
        const set = this.#listeners.get(event);
        if (set === undefined) return;
        // Snapshotted: a handler may unsubscribe itself — or another — mid-dispatch.
        const snapshot = Array.from(set);
        for (const handler of snapshot) (handler as (e: Events[K]) => void)(payload);
    }

    clear(): void {
        this.#listeners.clear();
    }
}
