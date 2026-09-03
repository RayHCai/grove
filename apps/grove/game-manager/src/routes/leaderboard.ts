import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ErrorBody, LeaderboardPage, LeaderboardQuery } from '@grove/api-contract';
import type { GameId } from '@grove/api-contract';

/**
 * The widest response this service returns, and the reason the response schema is declared.
 *
 * A declared response compiles to a `fast-json-stringify` serializer instead of `JSON.stringify`
 * walking an unknown object — which is the difference that shows on a hundred-row page, and it also
 * means a column added to the query cannot leak into the body without being added here first.
 */
export const leaderboardRoutes: FastifyPluginAsyncZod = async (app) => {
    app.get(
        '/leaderboard',
        {
            schema: {
                tags: ['leaderboard'],
                querystring: LeaderboardQuery,
                response: { 200: LeaderboardPage, 401: ErrorBody },
            },
        },
        async (request) => readPage(request.gameId, request.query),
    );
};

async function readPage(_game: GameId, query: LeaderboardQuery): Promise<LeaderboardPage> {
    return { board: query.board, entries: [], nextCursor: null };
}
