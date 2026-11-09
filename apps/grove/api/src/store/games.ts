import { PlayerId } from '@grove/api-contract';
import type { Games } from '../records.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { RECORD_NOT_FOUND, asGame, codeOf } from './shared.js';

/** The games table: who owns each game, who may reach it, and what was last published of it. */
export function prismaGames(db: PrismaClient): Games {
    return {
        ownerOf: async (game) => {
            const row = await db.game.findUnique({
                where: { id: game },
                select: { ownerId: true },
            });
            return row === null ? undefined : PlayerId.parse(row.ownerId);
        },

        createGame: async (owner, title) => {
            const game = await db.game.create({ data: { ownerId: owner, title } });
            return { outcome: 'created', game: asGame(game) };
        },

        gamesOf: async (owner, limit, after) => {
            // Strictly past the cursor in the listing's order, so a page boundary never repeats.
            const past =
                after === undefined
                    ? {}
                    : {
                          OR: [
                              { createdAt: { lt: new Date(after.createdAt) } },
                              { createdAt: new Date(after.createdAt), id: { lt: after.gameId } },
                          ],
                      };
            const rows = await db.game.findMany({
                where: { ownerId: owner, ...past },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: limit + 1,
            });
            const games = rows.slice(0, limit).map(asGame);
            const last = games.at(-1);
            return {
                games,
                next:
                    rows.length > limit && last !== undefined
                        ? { createdAt: last.createdAt, gameId: last.gameId }
                        : undefined,
            };
        },

        gameOf: async (game) => {
            const row = await db.game.findUnique({ where: { id: game } });
            return row === null ? undefined : asGame(row);
        },

        setVisibility: async (game, visibility) => {
            try {
                const row = await db.game.update({ where: { id: game }, data: { visibility } });
                return { outcome: 'updated', game: asGame(row) };
            } catch (error) {
                if (codeOf(error) === RECORD_NOT_FOUND) return { outcome: 'missing' };
                throw error;
            }
        },

        deleteGame: async (game) => {
            try {
                await db.game.delete({ where: { id: game } });
                return { outcome: 'deleted' };
            } catch (error) {
                if (codeOf(error) === RECORD_NOT_FOUND) return { outcome: 'missing' };
                throw error;
            }
        },

        publishedVersionOf: async (game) => {
            const row = await db.game.findUnique({
                where: { id: game },
                select: { publishedRevision: true, publishedAt: true },
            });
            // A CHECK keeps the two columns null or set together, so reading one is reading both.
            if (row === null || row.publishedRevision === null || row.publishedAt === null) {
                return undefined;
            }
            return {
                revision: row.publishedRevision,
                publishedAt: row.publishedAt.toISOString(),
            };
        },

        markPublished: async (game, version) => {
            await db.game.update({
                where: { id: game },
                data: {
                    publishedRevision: version.revision,
                    publishedAt: new Date(version.publishedAt),
                },
            });
        },
    };
}
