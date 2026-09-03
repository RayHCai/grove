import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ContentHash, ErrorBody, GameId } from '@grove/api-contract';
import { requireSession } from '../session.js';

/**
 * Project saves and version publishing.
 *
 * Multipart is registered HERE rather than on the app. A content-type parser is scoped to the
 * plugin that added it, so every other route keeps the JSON parser and this one alone accepts an
 * upload — which also means the body-size ceiling below applies to uploads and to nothing else.
 */
export const publishingRoutes: FastifyPluginAsyncZod = async (app) => {
    app.addHook('onRequest', requireSession);

    await app.register(import('@fastify/multipart'), {
        limits: { fileSize: 32 * 1024 * 1024, files: 1 },
    });

    app.post(
        '/games/:gameId/versions',
        {
            schema: {
                tags: ['publishing'],
                params: z.object({ gameId: GameId }),
                // The build is queued rather than run here: `buildScriptBundle` shells out to `tsc`
                // and a linker, which is minutes of CPU and has no business on a request.
                response: {
                    202: z.object({ jobId: z.uuid() }),
                    400: ErrorBody,
                    401: ErrorBody,
                    403: ErrorBody,
                },
            },
        },
        async (request, reply) => {
            const upload = await request.file();
            if (upload === undefined) {
                return reply.code(400).send({ code: 'invalid_request', message: 'no file' });
            }
            const jobId = await queueBuild(request.params.gameId, await upload.toBuffer());
            return reply.code(202).send({ jobId });
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

async function queueBuild(_game: GameId, _source: Buffer): Promise<string> {
    return crypto.randomUUID();
}

async function readLatest(
    _game: GameId,
): Promise<{ hash: ContentHash; publishedAt: string } | undefined> {
    return undefined;
}
