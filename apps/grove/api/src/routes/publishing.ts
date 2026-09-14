import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ContentHash, ErrorBody, GameId } from '@grove/api-contract';
import type { Builder } from '../builder.js';
import type { Records } from '../records.js';
import { requireCsrfToken, requireGameOwner, requireSession } from '../session.js';

/**
 * Project saves and version publishing.
 *
 * Multipart is registered HERE rather than on the app. A content-type parser is scoped to the
 * plugin that added it, so every other route keeps the JSON parser and this one alone accepts an
 * upload — which also means the body-size ceiling below applies to uploads and to nothing else.
 */
export function publishingRoutes(records: Records, builder: Builder): FastifyPluginAsyncZod {
    return async (app) => {
        app.addHook('onRequest', requireSession);
        app.addHook('onRequest', requireCsrfToken(app));
        app.addHook('preHandler', requireGameOwner(records));

        await app.register(import('@fastify/multipart'), {
            limits: { fileSize: 32 * 1024 * 1024, files: 1 },
        });

        app.post(
            '/games/:gameId/versions',
            {
                schema: {
                    tags: ['publishing'],
                    params: z.object({ gameId: GameId }),
                    // The build is queued rather than run here: a compile is minutes of CPU on a
                    // build box, and this service is the one replica every browser talks to.
                    response: {
                        202: z.object({ jobId: z.uuid() }),
                        400: ErrorBody,
                        401: ErrorBody,
                        403: ErrorBody,
                        429: ErrorBody,
                        501: ErrorBody,
                        502: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const upload = await request.file();
                if (upload === undefined) {
                    return reply.code(400).send({ code: 'invalid_request', message: 'no file' });
                }

                const queued = await builder.queue(
                    request.params.gameId,
                    await upload.toBuffer(),
                    request.id,
                );
                if (queued.outcome === 'rate_limited') {
                    return reply
                        .code(429)
                        .send({ code: 'rate_limited', message: 'too many builds for this game' });
                }
                // The id in a 202 is what a creator's editor polls, so a publish that reached no
                // builder says so rather than handing back one nothing will answer for.
                if (queued.outcome === 'unattached') {
                    return reply
                        .code(501)
                        .send({ code: 'internal', message: 'no build pipeline is attached' });
                }
                if (queued.outcome === 'unavailable') {
                    return reply
                        .code(502)
                        .send({ code: 'internal', message: 'build could not be queued' });
                }
                return reply.code(202).send({ jobId: queued.jobId });
            },
        );

        app.get(
            '/games/:gameId/versions/latest',
            {
                schema: {
                    tags: ['publishing'],
                    params: z.object({ gameId: GameId }),
                    response: {
                        200: z.object({ hash: ContentHash, publishedAt: z.iso.datetime() }),
                        403: ErrorBody,
                        404: ErrorBody,
                    },
                },
            },
            async (request, reply) => {
                const latest = await readLatest(request.params.gameId);
                if (latest === undefined) {
                    return reply.code(404).send({ code: 'not_found', message: 'never published' });
                }
                return reply.send(latest);
            },
        );
    };
}

async function readLatest(
    _game: GameId,
): Promise<{ hash: ContentHash; publishedAt: string } | undefined> {
    return undefined;
}
