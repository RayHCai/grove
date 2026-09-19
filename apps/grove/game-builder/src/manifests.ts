import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Manifest, manifestKey, type GameId } from '@grove/api-contract';
import type { Env } from './env.js';

/**
 * The snapshot a build compiles.
 *
 * Read by revision rather than handed over in the message: the manifest is immutable once written,
 * so fetching it is how a build that was queued minutes ago still compiles exactly the set the
 * creator pressed the button on.
 */
export interface Manifests {
    read(game: GameId, revision: number): Promise<Manifest | undefined>;
}

/** The manifest seam with nothing behind it: the games bucket lands here. */
export const unattachedManifests: Manifests = {
    read: async () => undefined,
};

/** A manifest is a couple of kilobytes, so this is a short call and never a stream. */
const READ_TIMEOUT_MS = 10_000;

export function s3Manifests(env: Env, bucket: string): Manifests {
    const client = new S3Client({
        region: env.AWS_REGION,
        ...(env.S3_ENDPOINT === undefined
            ? {}
            : { endpoint: env.S3_ENDPOINT, forcePathStyle: true }),
        requestHandler: { requestTimeout: READ_TIMEOUT_MS },
    });

    return {
        read: async (game, revision) => {
            const found = await client
                .send(new GetObjectCommand({ Bucket: bucket, Key: manifestKey(game, revision) }))
                .catch(() => undefined);
            if (found?.Body === undefined) return undefined;

            // Parsed rather than trusted: this object is what every path and version a build reads
            // comes from, and a half-written one would be a compile of somebody else's file set.
            const parsed = Manifest.safeParse(JSON.parse(await found.Body.transformToString()));
            return parsed.success ? parsed.data : undefined;
        },
    };
}
