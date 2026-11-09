// The seams a suite stands in for, each refusing what the real one would refuse.

import { Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import { VersionId, type TaskId, type TaskKind } from '@grove/api-contract';
import type { TaskQueue } from '../src/queue.js';
import {
    unattachedStores,
    type Accounts,
    type FleetHistory,
    type Games,
    type Stores,
    type Tasks,
    type Workspaces,
} from '../src/records.js';
import type { Presigned, Storage, StoredVersion } from '../src/storage.js';

export interface StoreOverrides {
    accounts?: Partial<Accounts> | undefined;
    games?: Partial<Games> | undefined;
    workspaces?: Partial<Workspaces> | undefined;
    tasks?: Partial<Tasks> | undefined;
    fleetHistory?: Partial<FleetHistory> | undefined;
}

/** Every seam unattached but what a case names, so a widened seam hands a double no answer. */
export function stores(over: StoreOverrides = {}): Stores {
    return {
        accounts: { ...unattachedStores.accounts, ...over.accounts },
        games: { ...unattachedStores.games, ...over.games },
        workspaces: { ...unattachedStores.workspaces, ...over.workspaces },
        tasks: { ...unattachedStores.tasks, ...over.tasks },
        fleetHistory: { ...unattachedStores.fleetHistory, ...over.fleetHistory },
    };
}

/** A stream that takes every push and remembers what it was told. */
export function announcing(): TaskQueue & { pushed: { kind: TaskKind; taskId: TaskId }[] } {
    const pushed: { kind: TaskKind; taskId: TaskId }[] = [];
    return {
        pushed,
        push: async (kind, taskId) => {
            pushed.push({ kind, taskId });
            return { outcome: 'pushed' };
        },
        close: async () => undefined,
    };
}

/** A log that keeps what it was told, so a case can assert on what only gets reported. */
export function recordingLog(): FastifyBaseLogger & {
    lines: { level: string; message: string }[];
} {
    const lines: { level: string; message: string }[] = [];
    const at =
        (level: string) =>
        (...args: unknown[]) => {
            lines.push({ level, message: String(args.at(-1)) });
        };
    const log = {
        lines,
        level: 'info',
        info: at('info'),
        warn: at('warn'),
        error: at('error'),
        debug: at('debug'),
        trace: at('trace'),
        fatal: at('fatal'),
        silent: () => undefined,
        child: () => log,
    };
    return log as unknown as FastifyBaseLogger & { lines: { level: string; message: string }[] };
}

interface Held {
    versionId: VersionId;
    body: Buffer;
    contentType: string;
    cacheControl: string | undefined;
    /** A delete marker, which holds no bytes and hides whatever is beneath it. */
    marker: boolean;
}

interface Signed {
    method: 'PUT' | 'GET';
    key: string;
    versionId?: VersionId | undefined;
    contentType?: string | undefined;
    byteLength?: number | undefined;
}

/** A versioned bucket that remembers every byte-set, as S3 with versioning on does. */
export interface Bucket extends Storage {
    versions: Map<string, Held[]>;
    /** What a key serves now, which is nothing under a delete marker. */
    current(key: string): Held | undefined;
    /** A request to a presigned URL, refused exactly where its signature would be. */
    send(
        url: string,
        body?: Buffer,
        headers?: Record<string, string>,
    ): { status: number; versionId?: VersionId; body?: Buffer };
    /** Every operation by name, in order, so a case can say which came first. */
    log: string[];
}

function stored(held: Held): StoredVersion {
    return {
        versionId: held.versionId,
        byteLength: held.body.byteLength,
        contentType: held.contentType,
    };
}

export function bucket(): Bucket {
    const versions = new Map<string, Held[]>();
    const signed = new Map<string, Signed>();
    const log: string[] = [];
    let minted = 0;
    let signatures = 0;

    const current = (key: string): Held | undefined => {
        const latest = versions.get(key)?.at(-1);
        return latest === undefined || latest.marker ? undefined : latest;
    };
    const at = (key: string, versionId?: VersionId): Held | undefined =>
        versionId === undefined
            ? current(key)
            : versions.get(key)?.find((held) => held.versionId === versionId && !held.marker);
    const write = (key: string, held: Omit<Held, 'versionId'>): Held => {
        minted += 1;
        const version = { ...held, versionId: VersionId.parse(`v${String(minted)}`) };
        versions.set(key, [...(versions.get(key) ?? []), version]);
        return version;
    };
    const sign = (
        terms: Signed,
        expiresInS: number,
        headers: Record<string, string>,
    ): Presigned => {
        signatures += 1;
        const url = `https://games.example/${terms.key}?X-Amz-Signature=${String(signatures)}`;
        signed.set(url, terms);
        return {
            outcome: 'signed',
            url,
            expiresAt: new Date(Date.now() + expiresInS * 1000).toISOString(),
            headers,
        };
    };

    return {
        versions,
        current,
        log,
        put: async (key, body, contentType, options = {}) => {
            log.push(`put ${key}`);
            const held = write(key, {
                body,
                contentType,
                cacheControl: options.cacheControl,
                marker: false,
            });
            return { outcome: 'written', version: stored(held) };
        },
        head: async (key, versionId) => {
            const held = at(key, versionId);
            return held === undefined ? undefined : stored(held);
        },
        get: async (key, versionId) => {
            const held = at(key, versionId);
            return held === undefined
                ? undefined
                : { body: held.body, contentType: held.contentType };
        },
        open: async (key, versionId) => {
            const held = at(key, versionId);
            return held === undefined
                ? undefined
                : {
                      body: Readable.from([held.body]),
                      contentType: held.contentType,
                      byteLength: held.body.byteLength,
                  };
        },
        remove: async (key) => {
            log.push(`remove ${key}`);
            write(key, {
                body: Buffer.alloc(0),
                contentType: '',
                cacheControl: undefined,
                marker: true,
            });
        },
        discard: async (key, versionId) => {
            log.push(`discard ${key}@${versionId}`);
            const left = (versions.get(key) ?? []).filter((held) => held.versionId !== versionId);
            // A key whose last version is gone is no key at all, as S3 lists it.
            if (left.length === 0) versions.delete(key);
            else versions.set(key, left);
        },
        erase: async (prefix) => {
            log.push(`erase ${prefix}`);
            for (const key of versions.keys()) {
                if (key.startsWith(prefix)) versions.delete(key);
            }
            return { outcome: 'erased' };
        },
        presignPut: async (key, { contentType, byteLength, expiresInS }) =>
            sign({ method: 'PUT', key, contentType, byteLength }, expiresInS, {
                'content-type': contentType,
            }),
        presignGet: async (key, versionId, expiresInS) =>
            sign({ method: 'GET', key, versionId }, expiresInS, {}),
        send: (url, body = Buffer.alloc(0), headers = {}) => {
            const terms = signed.get(url);
            if (terms === undefined) return { status: 403 };
            if (terms.method === 'GET') {
                const held = at(terms.key, terms.versionId);
                return held === undefined ? { status: 404 } : { status: 200, body: held.body };
            }
            // The signature covers the type and, where given, the length: anything else fails it.
            if (terms.contentType !== undefined && headers['content-type'] !== terms.contentType) {
                return { status: 403 };
            }
            if (terms.byteLength !== undefined && body.byteLength !== terms.byteLength) {
                return { status: 403 };
            }
            const held = write(terms.key, {
                body,
                contentType: terms.contentType ?? 'application/octet-stream',
                cacheControl: undefined,
                marker: false,
            });
            return { status: 200, versionId: held.versionId };
        },
    };
}
