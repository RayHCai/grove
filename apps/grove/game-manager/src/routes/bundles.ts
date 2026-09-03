import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { BundleSet, ErrorBody } from '@grove/api-contract';
import type { GameId } from '@grove/api-contract';

/**
 * Where a session learns which code every peer must be running.
 *
 * The bundles themselves are fetched from the URLs this returns, not through here — a service that
 * proxied multi-megabyte chunks would be on the join path for every player of every game.
 */
export const bundleRoutes: FastifyPluginAsyncZod = async (app) => {
    app.get(
        '/bundles',
        {
            schema: {
                tags: ['bundles'],
                response: { 200: BundleSet, 401: ErrorBody, 404: ErrorBody },
            },
        },
        async (request, reply) => {
            const bundles = await readBundles(request.gameId);
            if (bundles === undefined) {
                return reply.code(404).send({ code: 'not_found', message: 'never published' });
            }
            return reply.send(bundles);
        },
    );
};

async function readBundles(_game: GameId): Promise<BundleSet | undefined> {
    return undefined;
}
