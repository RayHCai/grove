import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorBody, PlayerId } from '@grove/api-contract';
import { requireSession } from '../session.js';

const Friend = z.object({
    playerId: PlayerId,
    displayName: z.string(),
    online: z.boolean(),
});

/**
 * Friends, presence, and the block list. A scope because of the second hook: `blockedBy` loads
 * once per request here and nowhere else, keeping that read off the join path.
 */
export const socialRoutes: FastifyPluginAsyncZod = async (app) => {
    app.addHook('onRequest', requireSession);
    app.addHook('preHandler', async (request) => {
        request.blockedBy = await loadBlocks(request.viewer.playerId);
    });

    app.get(
        '/friends',
        {
            schema: {
                tags: ['social'],
                response: { 200: z.array(Friend), 401: ErrorBody },
            },
        },
        async (request) => listFriends(request.viewer.playerId, request.blockedBy),
    );
};

declare module 'fastify' {
    interface FastifyRequest {
        /** Loaded by this scope's `preHandler`, and undefined anywhere else. */
        blockedBy: ReadonlySet<PlayerId>;
    }
}

async function loadBlocks(_viewer: PlayerId): Promise<ReadonlySet<PlayerId>> {
    return new Set();
}

async function listFriends(
    _viewer: PlayerId,
    _blockedBy: ReadonlySet<PlayerId>,
): Promise<z.infer<typeof Friend>[]> {
    return [];
}
