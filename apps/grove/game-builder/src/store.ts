import { BuildArtifact, Manifest, type TaskId, type WorkspacePath } from '@grove/api-contract';
import { fleetCall, type FleetCallInit } from '@grove/service-kit';
import type { Env } from './env.js';

/** `missing` is an answer (a revision nothing froze), where `unavailable` is the fleet failing. */
export type Fetched<T> =
    { outcome: 'found'; value: T } | { outcome: 'missing' } | { outcome: 'unavailable' };

export type Stored = { outcome: 'stored'; artifact: BuildArtifact } | { outcome: 'unavailable' };

/** Where a claimed build reads its pinned source and stores its output, through @grove/api. */
export interface BuildStore {
    manifest(task: TaskId): Promise<Fetched<Manifest>>;
    /** One source's bytes at the version the manifest froze, never what is current at the key. */
    file(task: TaskId, path: WorkspacePath): Promise<Fetched<Buffer>>;
    store(task: TaskId, name: string, body: Buffer, contentType: string): Promise<Stored>;
}

/** A source file is a script and a chunk is a few hundred kilobytes; neither is a slow transfer. */
const TRANSFER_TIMEOUT_MS = 30_000;

/** Every route below hangs off the one task this box claimed, the whole of what it sees. */
function taskPath(task: TaskId): string {
    return `/v1/fleet/tasks/${task}`;
}

/** One call to @grove/api under the builder's secret; undefined is an API that did not answer. */
export type ApiCall = (
    path: string,
    requestId: string,
    init?: FleetCallInit,
) => Promise<Response | undefined>;

export function apiCall(env: Env): ApiCall {
    const call = fleetCall({
        baseUrl: env.API_URL,
        secret: env.BUILDER_SECRET,
        timeoutMs: TRANSFER_TIMEOUT_MS,
    });
    return async (path, requestId, init) => call(path, requestId, init).catch(() => undefined);
}

export function httpStore(call: ApiCall): BuildStore {
    return {
        manifest: async (task) => {
            const answered = await call(`${taskPath(task)}/manifest`, task);
            if (answered === undefined) return { outcome: 'unavailable' };
            if (answered.status === 404) return { outcome: 'missing' };
            if (!answered.ok) return { outcome: 'unavailable' };

            // Parsed rather than cast: this decides which bytes are compiled.
            const parsed = Manifest.safeParse(await answered.json().catch(() => undefined));
            return parsed.success
                ? { outcome: 'found', value: parsed.data }
                : { outcome: 'unavailable' };
        },

        file: async (task, path) => {
            const answered = await call(`${taskPath(task)}/files/${path}`, task);
            if (answered === undefined) return { outcome: 'unavailable' };
            if (answered.status === 404) return { outcome: 'missing' };
            if (!answered.ok) return { outcome: 'unavailable' };

            const bytes = await answered.arrayBuffer().catch(() => undefined);
            return bytes === undefined
                ? { outcome: 'unavailable' }
                : { outcome: 'found', value: Buffer.from(bytes) };
        },

        store: async (task, name, body, contentType) => {
            const answered = await call(`${taskPath(task)}/build/${name}`, task, {
                method: 'PUT',
                headers: { 'content-type': contentType },
                body: new Uint8Array(body),
            });
            if (answered === undefined || !answered.ok) return { outcome: 'unavailable' };

            const parsed = BuildArtifact.safeParse(await answered.json().catch(() => undefined));
            // The address and digest are the API's answer; a build naming neither is unplayable.
            return parsed.success
                ? { outcome: 'stored', artifact: parsed.data }
                : { outcome: 'unavailable' };
        },
    };
}
