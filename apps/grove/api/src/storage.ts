import {
    DeleteObjectCommand,
    DeleteObjectsCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectVersionsCommand,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { VersionId } from '@grove/api-contract';
import type { FastifyBaseLogger } from 'fastify';
import type { Env } from './env.js';

/**
 * A read the bucket failed rather than answered, which a caller must not report as a 404.
 * Left to reach the error handler, it answers 503, which is what tells a builder to retry.
 */
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

/** `unattached` is a deploy with no bucket; `unavailable` is a bucket that would not answer. */
export type ObjectWritten =
    | { outcome: 'written'; version: StoredVersion }
    | { outcome: 'unattached' }
    | { outcome: 'unavailable' };

/** `unavailable` may have erased part of the prefix; erasing again finishes the job. */
export type PrefixErased =
    { outcome: 'erased' } | { outcome: 'unattached' } | { outcome: 'unavailable' };

export type UploadSigned =
    | { outcome: 'signed'; url: string; expiresAt: string }
    | { outcome: 'unattached' }
    | { outcome: 'unavailable' };

/**
 * The games bucket: one key per file, overwritten in place, with versioning keeping every prior
 * byte-set addressable.
 *
 * A key is `<gameId>/<class>/<path>`, so everything one game owns shares one prefix. That is what
 * lets the edge reach a game's build output and its assets while its source stays unreachable.
 *
 * Handed to `buildApp` beside `Records`, so what stands behind it is chosen where the process
 * starts rather than reached for by the route that saves a file.
 */
export interface Storage {
    /** Writes bytes at a key and hands back the version created for them. */
    put(key: string, body: Buffer, contentType: string): Promise<ObjectWritten>;
    /**
     * What is at a key right now.
     *
     * This is how an asset save learns a version and a length: the bytes went straight from the
     * browser to the bucket, so the editor's word for either is a claim rather than a fact.
     * Undefined is nothing at the key; a bucket that did not answer throws {@link StorageUnavailable}.
     */
    head(key: string): Promise<StoredVersion | undefined>;
    /**
     * One exact byte-set, named by the version a manifest froze rather than by what is current.
     *
     * The version is optional for the one class of key nothing ever overwrites: a build writes
     * under a prefix its own revision owns, so what is current there is what that build produced.
     * Undefined is no such key or version; a bucket that did not answer throws
     * {@link StorageUnavailable}.
     */
    get(key: string, versionId?: VersionId): Promise<StoredObject | undefined>;
    /**
     * Leaves a delete marker rather than erasing anything, so the history a manifest names survives.
     * Best effort: a failure is logged, and the bytes stay reachable only through a manifest.
     */
    remove(key: string): Promise<void>;
    /**
     * Every version and delete marker under a prefix, gone for good. Unlike `remove`, nothing is
     * left to roll back to: this is what deleting a whole game does to its `<gameId>/` prefix.
     */
    erase(prefix: string): Promise<PrefixErased>;
    /** A URL the browser PUTs an asset's bytes straight to, which is why this service never sees them. */
    presignPut(key: string, contentType: string): Promise<UploadSigned>;
}

/** The bucket seam with nothing behind it: the games bucket lands here. */
export const unattachedStorage: Storage = {
    // A read answers nothing rather than throwing, which the routes already turn into a 404; a
    // write names the seam, because storing nothing and reporting success would lose a creator's file.
    put: async () => ({ outcome: 'unattached' }),
    head: async () => undefined,
    get: async () => undefined,
    remove: async () => undefined,
    erase: async () => ({ outcome: 'unattached' }),
    presignPut: async () => ({ outcome: 'unattached' }),
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

/**
 * The games bucket over the AWS SDK, under whatever credentials the process was given.
 *
 * The log is reached for lazily, because the process builds its bucket before the app whose logger
 * it writes to.
 */
export function s3Storage(env: Env, bucket: string, log: () => FastifyBaseLogger): Storage {
    const failed = (operation: string, key: string, error: unknown): void => {
        log().error({ err: error, operation, key }, 'games bucket did not answer');
    };

    const client = new S3Client({
        region: env.AWS_REGION,
        // Set only where something other than AWS is answering (a local LocalStack, a test double)
        // and path style with it, because a bucket name is not a hostname there.
        ...(env.S3_ENDPOINT === undefined
            ? {}
            : { endpoint: env.S3_ENDPOINT, forcePathStyle: true }),
        requestHandler: { requestTimeout: OBJECT_TIMEOUT_MS },
    });

    return {
        put: async (key, body, contentType) => {
            const written = await client
                .send(
                    new PutObjectCommand({
                        Bucket: bucket,
                        Key: key,
                        Body: body,
                        ContentType: contentType,
                    }),
                )
                .catch((error: unknown) => {
                    failed('put', key, error);
                    return undefined;
                });

            if (written === undefined) return { outcome: 'unavailable' };
            const versionId = VersionId.safeParse(written.VersionId);
            // A bucket with versioning off answers no version, and a row naming one file set would
            // then name whatever that key holds later, which is the whole guarantee gone.
            if (!versionId.success) {
                failed('put', key, new Error('the bucket answered no version; is versioning on?'));
                return { outcome: 'unavailable' };
            }
            return {
                outcome: 'written',
                version: {
                    versionId: versionId.data,
                    byteLength: body.byteLength,
                    contentType,
                },
            };
        },

        head: async (key) => {
            let found;
            try {
                found = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
            } catch (error) {
                if (isAbsent(error)) return undefined;
                failed('head', key, error);
                throw new StorageUnavailable(key, { cause: error });
            }

            const versionId = VersionId.safeParse(found.VersionId);
            if (!versionId.success || found.ContentLength === undefined) {
                failed('head', key, new Error('the bucket answered no version or no length'));
                throw new StorageUnavailable(key);
            }
            return {
                versionId: versionId.data,
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

        remove: async (key) => {
            // No version, so this writes a delete marker over whatever is current: the bytes the
            // manifests already name are still there to roll back to.
            await client
                .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
                .catch((error: unknown) => {
                    log().warn({ err: error, key }, 'delete marker not written');
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

        presignPut: async (key, contentType) => {
            const expiresIn = env.ASSET_UPLOAD_TTL_S;
            // The type is signed in, so the bytes cannot arrive claiming to be something else. The
            // length is not: a presigned PUT carries no ceiling, and the save that follows reads
            // what actually landed and refuses an asset past the limit.
            const url = await getSignedUrl(
                client,
                new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
                { expiresIn },
            ).catch((error: unknown) => {
                failed('presign', key, error);
                return undefined;
            });

            if (url === undefined) return { outcome: 'unavailable' };
            return {
                outcome: 'signed',
                url,
                expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
            };
        },
    };
}
