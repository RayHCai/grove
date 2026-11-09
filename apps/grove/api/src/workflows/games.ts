import { uploadPrefix, type GameId } from '@grove/api-contract';
import type { GameDeleted, Games } from '../records.js';
import type { Storage } from '../storage.js';

export type Erased = GameDeleted | { outcome: 'unavailable' };

/** The bucket before the row, so an erase that fails leaves a game its owner can delete again. */
export async function deleteGame(
    deps: { games: Pick<Games, 'deleteGame'>; storage: Storage },
    game: GameId,
): Promise<Erased> {
    // The game's own prefix, and its quarantine, which sits under a prefix of its own.
    for (const prefix of [`${game}/`, uploadPrefix(game)]) {
        // oxlint-disable-next-line no-await-in-loop
        const erased = await deps.storage.erase(prefix);
        if (erased.outcome === 'unavailable') return { outcome: 'unavailable' };
    }
    return deps.games.deleteGame(game);
}
