import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { AssetUpload, AssetUploadRequest, ErrorBody, GameId } from '@grove/api-contract';
import type { Games } from '../records.js';
import { requireGameOwner, requireSignedIn } from '../session.js';
import type { Storage } from '../storage.js';
import { unattached } from '../reply.js';
import { requestUpload } from '../workflows/workspace.js';

/** Over the ceiling is a 413 the workflow says, rather than the 400 the contract's bound would. */
const UploadAsked = AssetUploadRequest.extend({ byteLength: z.int().positive() });

/** Where an asset's bytes are going: a presigned PUT into quarantine, and no row behind it. */
export function assetRoutes(
    games: Pick<Games, 'ownerOf'>,
    storage: Storage,
    ttlS: number,
): FastifyPluginAsyncZod {
    return async (app) => {
        requireSignedIn(app);
        app.addHook('preHandler', requireGameOwner(games));

        app.post(
            '/games/:gameId/assets',
            {
                schema: {
                    tags: ['workspace'],
                    params: z.object({ gameId: GameId }),
                    body: UploadAsked,
                    response: {
                        200: AssetUpload,
                        400: ErrorBody,
                        401: ErrorBody,
                        403: ErrorBody,
                        413: ErrorBody,
                        501: ErrorBody,
                        502: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const asked = await requestUpload(
                    storage,
                    ttlS,
                    request.params.gameId,
                    request.body,
                );
                if (asked.outcome === 'too_large') {
                    return reply
                        .code(413)
                        .send({ code: 'invalid_request', message: 'larger than an asset may be' });
                }
                if (asked.outcome === 'unattached') return unattached(reply, 'games bucket');
                if (asked.outcome === 'unavailable') {
                    return reply
                        .code(502)
                        .send({ code: 'internal', message: 'no upload could be signed' });
                }
                return reply.send(asked.upload);
            },
        );
    };
}
