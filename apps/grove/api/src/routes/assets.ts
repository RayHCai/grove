import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
    AssetUpload,
    AssetUploadRequest,
    ErrorBody,
    GameId,
    MAX_ASSET_BYTES,
    objectKey,
} from '@grove/api-contract';
import type { Records } from '../records.js';
import { requireCsrfToken, requireGameOwner, requireSession } from '../session.js';
import type { Storage } from '../storage.js';

/**
 * Where an asset's bytes are going.
 *
 * The answer is a presigned PUT and nothing else. Nothing is recorded here: a ticket the editor
 * never uses must not leave a row behind, so what puts an asset in a game is the save that names
 * its path afterwards — and that save reads back what actually landed.
 */
export function assetRoutes(records: Records, storage: Storage): FastifyPluginAsyncZod {
    return async (app) => {
        app.addHook('onRequest', requireSession);
        app.addHook('onRequest', requireCsrfToken(app));
        app.addHook('preHandler', requireGameOwner(records));

        app.post(
            '/games/:gameId/assets',
            {
                schema: {
                    tags: ['workspace'],
                    params: z.object({ gameId: GameId }),
                    body: AssetUploadRequest,
                    response: {
                        200: AssetUpload,
                        400: ErrorBody,
                        401: ErrorBody,
                        403: ErrorBody,
                        501: ErrorBody,
                        502: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const signed = await storage.presignPut(
                    objectKey(request.params.gameId, 'asset', request.body.path),
                    request.body.contentType,
                );
                if (signed.outcome === 'unattached') {
                    return reply
                        .code(501)
                        .send({ code: 'internal', message: 'no games bucket is attached' });
                }
                if (signed.outcome !== 'signed') {
                    return reply
                        .code(502)
                        .send({ code: 'internal', message: 'no upload could be signed' });
                }
                return reply.send({
                    path: request.body.path,
                    url: signed.url,
                    expiresAt: signed.expiresAt,
                    // Stated rather than signed in: a presigned PUT carries no ceiling of its own,
                    // and the save that follows is where an asset past this is refused.
                    maxBytes: MAX_ASSET_BYTES,
                });
            },
        );
    };
}
