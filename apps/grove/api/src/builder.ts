import { createHash } from 'node:crypto';
import {
    BuildJob,
    REQUEST_ID_HEADER,
    type BuildJobId,
    type BuildRequest,
    type GameId,
} from '@grove/api-contract';
import type { Env } from './env.js';

/** What asking for a build came back as. Only `queued` names a job anything will ever answer for. */
export type BuildQueued =
    | { outcome: 'queued'; jobId: BuildJobId }
    | { outcome: 'rate_limited' }
    | { outcome: 'unattached' }
    | { outcome: 'unavailable' };

/**
 * What a publish does with the bytes it was handed: store them, and ask for a build of them.
 *
 * Handed to `buildApp` the way `Records` is, so the two services behind it are one dependency of
 * this service rather than a pair of URLs the publish route reaches for.
 */
export interface Builder {
    // Passed rather than read off a request, because this seam holds no Fastify types — and a
    // publish the two services behind it logged under ids of their own is one nothing can follow.
    queue(game: GameId, source: Buffer, requestId: string): Promise<BuildQueued>;
}

/** The build seam with nothing behind it: @grove/upload-service and @grove/game-builder land here. */
export const unattachedBuilder: Builder = {
    // Naming the seam rather than minting an id: a job id no builder will ever answer for is one a
    // creator's editor polls until it gives up.
    queue: async () => ({ outcome: 'unattached' }),
};

// An upload runs to the publish route's own 32 MiB ceiling, so its deadline is not the queue call's.
const OBJECT_TIMEOUT_MS = 30_000;
const QUEUE_TIMEOUT_MS = 2_000;

/** The object store and the build queue over HTTP, behind the bearer both of their gates compare. */
export function httpBuilder(env: Env): Builder {
    return {
        queue: async (game, source, requestId) => {
            // The name is the content, so a republish of identical bytes stores nothing twice and
            // the build request carries an address rather than the source itself.
            const sourceHash = createHash('sha256').update(source).digest('hex');

            const stored = await fetch(`${env.UPLOAD_SERVICE_URL}/v1/objects/${sourceHash}`, {
                method: 'PUT',
                headers: {
                    'content-type': 'application/octet-stream',
                    authorization: `Bearer ${env.FLEET_SECRET}`,
                    [REQUEST_ID_HEADER]: requestId,
                },
                body: source,
                signal: AbortSignal.timeout(OBJECT_TIMEOUT_MS),
            });
            // 200 is the same bytes already under that name, which a build can name as readily.
            if (!stored.ok) return { outcome: 'unavailable' };

            const queued = await fetch(`${env.GAME_BUILDER_URL}/v1/builds`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${env.FLEET_SECRET}`,
                    [REQUEST_ID_HEADER]: requestId,
                },
                body: JSON.stringify({ gameId: game, sourceHash } satisfies BuildRequest),
                signal: AbortSignal.timeout(QUEUE_TIMEOUT_MS),
            });
            // Relayed rather than folded into the failure below: a ration says to come back, and a
            // caller told the builder is broken stops trying.
            if (queued.status === 429) return { outcome: 'rate_limited' };
            if (!queued.ok) return { outcome: 'unavailable' };

            return { outcome: 'queued', jobId: BuildJob.parse(await queued.json()).jobId };
        },
    };
}
