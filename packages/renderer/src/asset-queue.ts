// Pure. An intent map, not a log: load -> unload -> load collapses to one net load, so the queue
// is bounded by the number of distinct asset names and needs no growth cap.
//
// Iteration is first-mention order per name, because `Map.set` on an existing key updates in
// place without moving it — so churn changes intents without reordering the restore.

import type { AssetManifestEntry } from './renderer.js';

/** What the queue intends for one name. */
export type AssetIntent = { op: 'load'; entry: AssetManifestEntry } | { op: 'unload' };

/** The work a restore should perform, after merging the retained manifest with the queue. */
export interface MergedAssetWork {
    /** Entries to (re-)upload, retained-manifest order first, then queued additions. */
    toLoad: AssetManifestEntry[];
    /** Names to drop. */
    toUnload: string[];
}

/**
 * Pending GPU asset work, keyed by asset name.
 *
 * Store mutations apply immediately during a context loss; GPU operations land here instead and
 * are applied on restore.
 */
export class AssetQueue {
    readonly #intents = new Map<string, AssetIntent>();

    /** Distinct names with a pending intent — feeds `pendingAssetOps`. */
    get size(): number {
        return this.#intents.size;
    }

    /** Queues a load, replacing any pending intent for that name. */
    load(entry: AssetManifestEntry): void {
        this.#intents.set(entry.name, { op: 'load', entry });
    }

    /** Queues an unload, replacing any pending intent for that name. */
    unload(name: string): void {
        this.#intents.set(name, { op: 'unload' });
    }

    /** The pending intent for a name, or undefined. */
    intentFor(name: string): AssetIntent | undefined {
        return this.#intents.get(name);
    }

    /** Every queued name, in first-mention order. `out` is truncated, then refilled. */
    names(out: string[] = []): string[] {
        out.length = 0;
        for (const name of this.#intents.keys()) {
            out.push(name);
        }
        return out;
    }

    /**
     * Merges `retained` — what was resident before the loss — with the queued intents.
     *
     * Merging before applying is what lets a queued unload suppress a re-upload; the reverse
     * order resurrects assets a level transition meant to drop.
     */
    merge(retained: ReadonlyMap<string, AssetManifestEntry>): MergedAssetWork {
        const toLoad: AssetManifestEntry[] = [];
        const toUnload: string[] = [];

        // Retained first, so re-uploads keep their manifest order. A name that is both retained
        // and queued-load uses the queued entry — the newer declaration.
        for (const [name, entry] of retained) {
            const intent = this.#intents.get(name);
            if (intent === undefined) {
                toLoad.push(entry);
            } else if (intent.op === 'load') {
                toLoad.push(intent.entry);
            } else {
                toUnload.push(name);
            }
        }

        for (const [name, intent] of this.#intents) {
            if (retained.has(name)) continue;
            if (intent.op === 'load') {
                toLoad.push(intent.entry);
            } else {
                // Never resident, reported anyway: unloading an unknown name is idempotent.
                toUnload.push(name);
            }
        }

        return { toLoad, toUnload };
    }

    /** Drops every pending intent. */
    clear(): void {
        this.#intents.clear();
    }

    /** Intended residency: the queue's verdict when it has one, else `resident`. */
    intendedHas(name: string, resident: boolean): boolean {
        const intent = this.#intents.get(name);
        if (intent === undefined) return resident;
        return intent.op === 'load';
    }
}
