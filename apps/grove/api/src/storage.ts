import type { Readable } from 'node:stream';
import {
    DeleteObjectCommand,
    DeleteObjectsCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectVersionsCommand,
    PutObjectCommand,
    S3Client,
    type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { VersionId } from '@grove/api-contract';
import type { FastifyBaseLogger } from 'fastify';
import type { Env } from './env.js';

/** A read the bucket failed rather than answered, which the error handler makes a retried 503. */
export class StorageUnavailable extends Error {
    readonly statusCode = 503;

    constructor(key: string, options?: ErrorOptions) {
        super(`the games bucket did not answer for ${key}`, options);
        this.name = 'StorageUnavailable';
    }
}

/** What landed at a key: the version the bucket minted, and what it actually holds. */
export interface StoredVersion {
    versionId: VersionId;
    byteLength: number;
    contentType: string;
}

/** Bytes as the bucket holds them, under the type they were written with. */
export interface StoredObject {
    body: Buffer;
    contentType: string;
}

/** Bytes still arriving, for a read too large to hold in memory on the way through. */
export interface ObjectStream {
    body: Readable;
    contentType: string;
    byteLength: number;
}

/** `unattached` is a deploy with no bucket; `unavailable` is a bucket that would not answer. */
export type ObjectWritten =
    | { outcome: 'written'; version: StoredVersion }
    | { outcome: 'unattached' }
    | { outcome: 'unavailable' };

/** `unavailable` may have erased part of the prefix; erasing again finishes the job. */
export type PrefixErased =
    { outcome: 'erased' } | { outcome: 'unattached' } | { outcome: 'unavailable' };

/** A URL and the headers its signature covers, which the request must carry exactly. */
export type Presigned =
    | { outcome: 'signed'; url: string; expiresAt: string; headers: Record<string, string> }
    | { outcome: 'unattached' }
    | { outcome: 'unavailable' };

export interface PutOptions {
    cacheControl?: string;
}

/** What a presigned PUT holds its sender to, beyond the key it names. */
export interface PutTerms {
    contentType: string;
    /** Signed in when given, so the bucket refuses a body of any other length. */
    byteLength?: number;
    expiresInS: number;
}

/** The games bucket: one key per file, overwritten in place, versioning keeping every byte-set. */
export interface Storage {
    put(
        key: string,
        body: Buffer,
        contentType: string,
        options?: PutOptions,
    ): Promise<ObjectWritten>;
    /** What a key holds now, or at one version; undefined is nothing there, an outage throws. */
    head(key: string, versionId?: VersionId): Promise<StoredVersion | undefined>;
    /** One small byte-set, by version where named; an outage throws {@link StorageUnavailable}. */
    get(key: string, versionId?: VersionId): Promise<StoredObject | undefined>;
    /** One byte-set as a stream, for a file the editor reads back. */
    open(key: string, versionId: VersionId): Promise<ObjectStream | undefined>;
    /** A delete marker, so the versions a manifest names survive; best effort, and logged. */
    remove(key: string): Promise<void>;
    /** One version gone for good, for bytes nothing names; best effort, and logged. */
    discard(key: string, versionId: VersionId): Promise<void>;
    /** Every version and delete marker under a prefix, gone for good. */
    erase(prefix: string): Promise<PrefixErased>;
    presignPut(key: string, terms: PutTerms): Promise<Presigned>;
    presignGet(key: string, versionId: VersionId, expiresInS: number): Promise<Presigned>;
}

// A read answers nothing, which the routes already make a 404; a write names the seam, because
// reporting a stored file nobody stored would lose a creator's work.
export const unattachedStorage: Storage = {
    put: async () => ({ outcome: 'unattached' }),
    head: async () => undefined,
    get: async () => undefined,
    open: async () => undefined,
    remove: async () => undefined,
    discard: async () => undefined,
    erase: async () => ({ outcome: 'unattached' }),
    presignPut: async () => ({ outcome: 'unattached' }),
    presignGet: async () => ({ outcome: 'unattached' }),
};

/** A manifest is two kilobytes and a source file is small; neither is a multi-megabyte stream. */
const OBJECT_TIMEOUT_MS = 15_000;

/** What S3 answers for a key, a version or a delete marker that holds no bytes to read. */
const ABSENT_NAMES = new Set(['NoSuchKey', 'NoSuchVersion', 'NotFound', 'MethodNotAllowed']);
const ABSENT_STATUSES = new Set([404, 405]);

function isAbsent(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const { name, $metadata } = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    return (
        (name !== undefined && ABSENT_NAMES.has(name)) ||
        ABSENT_STATUSES.has($metadata?.httpStatusCode ?? 0)
    );
}

/** The games bucket over the AWS SDK; the log is a thunk, since its app is built later. */
export function s3Storage(env: Env, bucket: string, log: () => FastifyBaseLogger): Storage {
    const failed = (operation: string, key: string, error: unknown): void => {
        log().error({ err: error, operation, key }, 'games bucket did not answer');
    };

    const config: S3ClientConfig = {
        region: env.AWS_REGION,
        // Path style where something other than AWS answers: a bucket is no hostname there.
        ...(env.S3_ENDPOINT === undefined
            ? {}
            : { endpoint: env.S3_ENDPOINT, forcePathStyle: true }),
        requestHandler: { requestTimeout: OBJECT_TIMEOUT_MS },
    };
    const client = new S3Client(config);
    // A presign carrying the SDK's checksum of its empty body is refused for every real one.
    const presigner = new S3Client({
        ...config,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
    });

    const signed = async (
        key: string,
        command: PutObjectCommand | GetObjectCommand,
        expiresInS: number,
        headers: Record<string, string>,
    ): Promise<Presigned> => {
        const url = await getSignedUrl(presigner, command, {
            expiresIn: expiresInS,
            // The presigner leaves the type unsigned unless told, which would let any type land.
            signableHeaders: new Set(Object.keys(headers)),
        }).catch((error: unknown) => {
            failed('presign', key, error);
            return undefined;
        });
        if (url === undefined) return { outcome: 'unavailable' };
        const { 'content-length': _length, ...sent } = headers;
        return {
            outcome: 'signed',
            url,
            expiresAt: new Date(Date.now() + expiresInS * 1000).toISOString(),
            headers: sent,
        };
    };

    return {
        put: async (key, body, contentType, options = {}) => {
            const written = await client
                .send(
                    new PutObjectCommand({
                        Bucket: bucket,
                        Key: key,
                        Body: body,
                        ContentType: contentType,
                        CacheControl: options.cacheControl,
                    }),
                )
                .catch((error: unknown) => {
                    failed('put', key, error);
                    return undefined;
                });

            if (written === undefined) return { outcome: 'unavailable' };
            const versionId = VersionId.safeParse(written.VersionId);
            // A bucket with versioning off answers no version, and a row would name nothing fixed.
            if (!versionId.success) {
                failed('put', key, new Error('the bucket answered no version; is versioning on?'));
                return { outcome: 'unavailable' };
            }
            return {
                outcome: 'written',
                version: { versionId: versionId.data, byteLength: body.byteLength, contentType },
            };
        },

        head: async (key, versionId) => {
            let found;
            try {
                found = await client.send(
                    new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
                );
            } catch (error) {
                if (isAbsent(error)) return undefined;
                failed('head', key, error);
                throw new StorageUnavailable(key, { cause: error });
            }

            const version = VersionId.safeParse(found.VersionId);
            if (!version.success || found.ContentLength === undefined) {
                failed('head', key, new Error('the bucket answered no version or no length'));
                throw new StorageUnavailable(key);
            }
            return {
                versionId: version.data,
                byteLength: found.ContentLength,
                contentType: found.ContentType ?? 'application/octet-stream',
            };
        },

        get: async (key, versionId) => {
            try {
                const found = await client.send(
                    new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
                );
                if (found.Body === undefined) return undefined;
                return {
                    body: Buffer.from(await found.Body.transformToByteArray()),
                    contentType: found.ContentType ?? 'application/octet-stream',
                };
            } catch (error) {
                if (isAbsent(error)) return undefined;
                failed('get', key, error);
                throw new StorageUnavailable(key, { cause: error });
            }
        },

        open: async (key, versionId) => {
            try {
                const found = await client.send(
                    new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
                );
                if (found.Body === undefined || found.ContentLength === undefined) return undefined;
                return {
                    body: found.Body as Readable,
                    contentType: found.ContentType ?? 'application/octet-stream',
                    byteLength: found.ContentLength,
                };
            } catch (error) {
                if (isAbsent(error)) return undefined;
                failed('open', key, error);
                throw new StorageUnavailable(key, { cause: error });
            }
        },

        remove: async (key) => {
            await client
                .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
                .catch((error: unknown) => {
                    log().warn({ err: error, key }, 'delete marker not written');
                });
        },

        discard: async (key, versionId) => {
            await client
                .send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }))
                .catch((error: unknown) => {
                    log().warn({ err: error, key, versionId }, 'version not discarded');
                });
        },

        erase: async (prefix) => {
            try {
                let keyMarker: string | undefined;
                let versionIdMarker: string | undefined;
                for (;;) {
                    // Sequential by necessity: each page's markers are what the next request names.
                    // oxlint-disable-next-line no-await-in-loop
                    const page = await client.send(
                        new ListObjectVersionsCommand({
                            Bucket: bucket,
                            Prefix: prefix,
                            KeyMarker: keyMarker,
                            VersionIdMarker: versionIdMarker,
                        }),
                    );
                    // A page is at most a thousand entries, which is also DeleteObjects' ceiling.
                    const doomed = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
                        .filter((entry) => entry.Key !== undefined)
                        .map((entry) => ({ Key: entry.Key, VersionId: entry.VersionId }));
                    if (doomed.length > 0) {
                        // oxlint-disable-next-line no-await-in-loop
                        const deleted = await client.send(
                            new DeleteObjectsCommand({
                                Bucket: bucket,
                                Delete: { Objects: doomed, Quiet: true },
                            }),
                        );
                        if ((deleted.Errors ?? []).length > 0) {
                            failed('erase', prefix, deleted.Errors);
                            return { outcome: 'unavailable' };
                        }
                    }
                    if (page.IsTruncated !== true) return { outcome: 'erased' };
                    keyMarker = page.NextKeyMarker;
                    versionIdMarker = page.NextVersionIdMarker;
                }
            } catch (error) {
                failed('erase', prefix, error);
                return { outcome: 'unavailable' };
            }
        },

        presignPut: async (key, { contentType, byteLength, expiresInS }) =>
            signed(
                key,
                new PutObjectCommand({
                    Bucket: bucket,
                    Key: key,
                    ContentType: contentType,
                    ContentLength: byteLength,
                }),
                expiresInS,
                {
                    'content-type': contentType,
                    ...(byteLength === undefined ? {} : { 'content-length': String(byteLength) }),
                },
            ),

        presignGet: async (key, versionId, expiresInS) =>
            signed(
                key,
                new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
                expiresInS,
                {},
            ),
    };
}
