// An intent map, not a log: load → unload → load collapses to one net load, so the queue is
// bounded by distinct names. Iteration is first-mention order per name.

import { rendererError } from './errors.js';
import type { AssetManifestEntry } from './renderer.js';

/** What the queue intends for one name. */
export type AssetIntent = { op: 'load'; entry: AssetManifestEntry } | { op: 'unload' };

/** Schemes the asset loader may fetch from; a server-supplied manifest is checked, not trusted. */
export const LOADER_ASSET_SCHEMES: ReadonlySet<string> = new Set([
    'http:',
    'https:',
    'data:',
    'blob:',
]);

/** Schemes a server manifest may name; narrower — `data:` and `blob:` are ours to construct. */
export const REMOTE_ASSET_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

/** Resolves a relative url. Only its scheme matters, and `http:` is in every allowed set. */
const RELATIVE_URL_BASE = 'http://localhost/';

/** Throws `invalid-asset-entry` unless the entry is usable; shared, so backends agree. */
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
            if (!isAllowedAssetUrl(entry.url, LOADER_ASSET_SCHEMES)) {
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

/**
 * `true` for a relative path or an absolute url whose scheme is in `allowed`.
 * Parsed, never pattern-matched: a lexical test is defeated by what the parser normalises away.
 */
export function isAllowedAssetUrl(url: string, allowed: ReadonlySet<string>): boolean {
    try {
        return allowed.has(new URL(url, RELATIVE_URL_BASE).protocol);
    } catch {
        // An unparseable url is no more fetchable than a forbidden one.
        return false;
    }
}

/** The work a restore should perform, after merging the retained manifest with the queue. */
export interface MergedAssetWork {
    /** Entries to (re-)upload, retained-manifest order first, then queued additions. */
    toLoad: AssetManifestEntry[];
    /** Names to drop. */
    toUnload: string[];
}

/** Pending GPU asset work by name: store mutations apply at once, GPU work waits for restore. */
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

    /** Merges `retained` with the queued intents; merging first lets an unload cancel a load. */
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
