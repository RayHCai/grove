import type { Game } from '@grove/api-contract';
import { hueOf, placeholderDetail, placeholderIndex, tileAt } from './placeholder';
import type { ServerSlot } from './placeholder';

/**
 * Everything a game page shows, from whichever source had it.
 *
 * A number the service does not count is `undefined` rather than zero: a real game has had
 * visitors nobody tallied, and `0` would be a claim about them.
 */
export interface GameDetail {
    gameId: string;
    title: string;
    creator: string;
    hue: number;
    description: string | undefined;
    genre: string | undefined;
    playing: number | undefined;
    favorites: number | undefined;
    visits: number | undefined;
    capacity: number | undefined;
    likes: number | undefined;
    dislikes: number | undefined;
    createdAt: string;
    /** The last publish, or `undefined` for a game that has never been published. */
    updatedAt: string | undefined;
    /** `undefined` where there is no list of running servers to read. */
    servers: ServerSlot[] | undefined;
    /** The game the service holds, which is what Play needs; `undefined` for a placeholder. */
    game: Game | undefined;
}

/** A placeholder game's page, or `undefined` for an id no placeholder carries. */
export function placeholderGame(gameId: string): GameDetail | undefined {
    const n = placeholderIndex(gameId);
    if (n === undefined) return undefined;
    const tile = tileAt(n);
    const facts = placeholderDetail(n);
    return {
        gameId,
        title: tile.title,
        creator: tile.creator,
        hue: tile.hue,
        description: facts.description,
        genre: facts.genre,
        playing: tile.playing,
        favorites: facts.favorites,
        visits: facts.visits,
        capacity: facts.capacity,
        likes: facts.likes,
        dislikes: facts.dislikes,
        createdAt: facts.createdAt,
        updatedAt: facts.updatedAt,
        servers: facts.servers,
        game: undefined,
    };
}

/** A game the service holds, with what it knows and nothing it does not. */
export function heldGame(game: Game, creator: string): GameDetail {
    return {
        gameId: game.gameId,
        title: game.title,
        creator,
        hue: hueOf(game.gameId),
        description: undefined,
        genre: undefined,
        playing: undefined,
        favorites: undefined,
        visits: undefined,
        capacity: undefined,
        likes: undefined,
        dislikes: undefined,
        createdAt: game.createdAt,
        updatedAt: game.publishedAt ?? undefined,
        servers: undefined,
        game,
    };
}
