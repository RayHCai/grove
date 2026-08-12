// Pure. An intent map, not a log: load -> unload -> load collapses to one net load, so the queue
// is bounded by the number of distinct asset names and needs no growth cap.
//
// Iteration is first-mention order per name, because `Map.set` on an existing key updates in
// place without moving it — so churn changes intents without reordering the restore.

import { rendererError } from './errors.js';
import type { AssetManifestEntry } from './renderer.js';

/** What the queue intends for one name. */
export type AssetIntent = { op: 'load'; entry: AssetManifestEntry } | { op: 'unload' };

/**
 * URL schemes an asset may be fetched from.
 *
 * A manifest can arrive from a server, so the scheme is checked rather than assumed: `javascript:`
 * and `file:` have no business reaching a loader, and a relative path — the ordinary case — has no
 * scheme at all.
 */
const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'data:', 'blob:']);

/**
 * Throws `invalid-asset-entry` unless the entry is structurally usable.
 *
 * Shared by both backends: a manifest the headless backend accepts and the Pixi one rejects is a
 * divergence the contract suite cannot see, since it runs against one of them.
 */
export function validateAssetEntry(entry: AssetManifestEntry): void {
    if (typeof entry?.name !== 'string' || entry.name === '') {
        rendererError('invalid-asset-entry', 'an asset entry needs a non-empty name');
    }
    switch (entry.kind) {
        case 'image':
        case 'atlas':
        case 'font':
            if (typeof entry.url !== 'string' || entry.url === '') {
                rendererError(
                    'invalid-asset-entry',
                    `asset '${entry.name}' (${entry.kind}) needs a non-empty url`,
                );
            }
            if (!isAllowedAssetUrl(entry.url)) {
                rendererError(
                    'invalid-asset-entry',
                    `asset '${entry.name}' has a url with a disallowed scheme`,
                );
            }
            return;
        case 'text':
            if (typeof entry.text !== 'string') {
                rendererError('invalid-asset-entry', `text asset '${entry.name}' needs a string`);
            }
            return;
        default:
            rendererError(
                'invalid-asset-entry',
                `asset '${String((entry as { name?: string }).name)}' has an unknown kind ` +
                    `'${String((entry as { kind?: string }).kind)}'`,
            );
    }
}

/** `true` for a relative path or an allowed absolute scheme. */
export function isAllowedAssetUrl(url: string): boolean {
    const scheme = /^([a-z][a-z\d+\-.]*):/i.exec(url);
    return scheme === null || ALLOWED_SCHEMES.has(scheme[1]?.toLowerCase() + ':');
}

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
