import { createHash } from 'node:crypto';
import {
    Manifest,
    buildPrefix,
    manifestKey,
    objectKey,
    type BuildArtifact,
    type TaskId,
    type WorkspacePath,
} from '@grove/api-contract';
import type { BuildWork, Tasks } from '../records.js';
import type { Storage, StoredObject } from '../storage.js';

/** Content-addressed keys never change bytes, so a cache in front of them may keep them forever. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** How many builds' manifests one process keeps parsed, which is every build in flight and more. */
const MANIFESTS_HELD = 64;

/** Parsed once per build, not once per file: a manifest key is written once and never again. */
export class ManifestCache {
    readonly #held = new Map<string, Manifest>();
    readonly #cap: number;

    constructor(cap: number = MANIFESTS_HELD) {
        this.#cap = cap;
    }

    async read(
        key: string,
        load: () => Promise<Manifest | undefined>,
    ): Promise<Manifest | undefined> {
        const held = this.#held.get(key);
        if (held !== undefined) return held;
        const loaded = await load();
        if (loaded === undefined) return undefined;
        this.#held.set(key, loaded);
        // Oldest first, since a Map iterates in insertion order.
        for (const stale of this.#held.keys()) {
            if (this.#held.size <= this.#cap) break;
            this.#held.delete(stale);
        }
        return loaded;
    }
}

export interface BuildDeps {
    tasks: Pick<Tasks, 'buildOf' | 'recordArtifact'>;
    storage: Storage;
    manifests: ManifestCache;
    cdnUrl: string;
}

/** `unclaimed` is a build nobody holds, whose source no worker has any business reading. */
export type Sourced<T> =
    { outcome: 'found'; value: T } | { outcome: 'missing' } | { outcome: 'unclaimed' };

async function claimedBuild(
    deps: BuildDeps,
    taskId: TaskId,
): Promise<{ outcome: 'found'; work: BuildWork } | { outcome: 'missing' | 'unclaimed' }> {
    const work = await deps.tasks.buildOf(taskId);
    if (work === undefined) return { outcome: 'missing' };
    return work.live ? { outcome: 'found', work } : { outcome: 'unclaimed' };
}

/** The manifest a claimed build is pinned to, as its save froze it. */
export async function manifestFor(deps: BuildDeps, taskId: TaskId): Promise<Sourced<Manifest>> {
    const claimed = await claimedBuild(deps, taskId);
    if (claimed.outcome !== 'found') return claimed;
    const { work } = claimed;

    const key = manifestKey(work.gameId, work.revision, work.saveId);
    const manifest = await deps.manifests.read(key, async () => {
        const found = await deps.storage.get(key);
        if (found === undefined) return undefined;
        // Parsed rather than cast: this decides which bytes a build box is handed.
        const parsed = Manifest.safeParse(safeJson(found.body.toString('utf8')));
        return parsed.success &&
            parsed.data.gameId === work.gameId &&
            parsed.data.revision === work.revision
            ? parsed.data
            : undefined;
    });
    return manifest === undefined ? { outcome: 'missing' } : { outcome: 'found', value: manifest };
}

/** One source at the version that manifest named; an asset is the edge's, never a compiler's. */
export async function sourceFor(
    deps: BuildDeps,
    taskId: TaskId,
    path: WorkspacePath,
): Promise<Sourced<StoredObject>> {
    const manifest = await manifestFor(deps, taskId);
    if (manifest.outcome !== 'found') return manifest;
    const file = manifest.value.files.find((held) => held.path === path);
    if (file === undefined || file.kind !== 'source') return { outcome: 'missing' };

    const found = await deps.storage.get(
        objectKey(manifest.value.gameId, 'source', path),
        file.versionId,
    );
    return found === undefined ? { outcome: 'missing' } : { outcome: 'found', value: found };
}

export type OutputStored =
    | { outcome: 'stored'; artifact: BuildArtifact }
    | { outcome: 'missing' }
    | { outcome: 'unclaimed' }
    | { outcome: 'unattached' }
    | { outcome: 'unavailable' };

/** Stores one output under its own digest and records it, which is what a success is held to. */
export async function storeOutput(
    deps: BuildDeps,
    taskId: TaskId,
    name: string,
    body: Buffer,
): Promise<OutputStored> {
    const claimed = await claimedBuild(deps, taskId);
    if (claimed.outcome !== 'found') return claimed;

    const hash = createHash('sha256').update(body).digest('hex');
    const key = `${buildPrefix(claimed.work.gameId, taskId)}${hash}/${name}`;
    const written = await deps.storage.put(key, body, contentTypeOf(name), {
        cacheControl: IMMUTABLE,
    });
    if (written.outcome !== 'written') return written;

    const artifact: BuildArtifact = {
        name,
        url: `${deps.cdnUrl.replace(/\/+$/u, '')}/${key}`,
        hash,
        byteLength: body.byteLength,
    };
    await deps.tasks.recordArtifact(taskId, artifact);
    return { outcome: 'stored', artifact };
}

/** Two kinds a build produces and nothing else, so no worker can have the edge serve a page. */
function contentTypeOf(name: string): string {
    if (name.endsWith('.js')) return 'text/javascript';
    if (name.endsWith('.json')) return 'application/json';
    return 'application/octet-stream';
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}
