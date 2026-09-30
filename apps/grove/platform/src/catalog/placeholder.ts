/**
 * Made-up games, deterministically, from an index.
 *
 * There is no listing of public games to ask and no counters behind a game (visits, favourites,
 * votes, running servers), so everything the front page browses, and every such number a game page
 * shows, comes from here. The shape of those pages is what is being built; a real listing slots in
 * where `tileAt` is, and real counters where `placeholderDetail` is.
 */

/** One game as a shelf shows it. */
export interface Tile {
    id: string;
    title: string;
    creator: string;
    playing: number;
    hue: number;
}

/** One running copy of a game, as its server list shows it. */
export interface ServerSlot {
    id: string;
    players: number;
    capacity: number;
}

/** What a game page shows beyond the tile, none of which the service can answer yet. */
export interface PlaceholderFacts {
    description: string;
    genre: string;
    favorites: number;
    visits: number;
    capacity: number;
    likes: number;
    dislikes: number;
    createdAt: string;
    updatedAt: string;
    servers: ServerSlot[];
}

const WORDS = ['Pip', 'Moss', 'Ember', 'Fern', 'Clover', 'Bramble', 'Juniper', 'Willow', 'Acorn'];
const THINGS = [
    'Garden',
    'Tower',
    'Rally',
    'Harbor',
    'Quest',
    'Dash',
    'Village',
    'Caves',
    'Tycoon',
];
const GENRES = ['Adventure', 'Obby', 'Roleplay', 'Tycoon', 'Racing', 'Puzzle', 'Hangout'];
const CAPACITIES = [8, 12, 16, 20, 24, 30];

const PREFIX = 'game-';
const DAY_MS = 86_400_000;
// A fixed epoch rather than the clock, so a game's dates are the same on every visit.
const EPOCH = Date.UTC(2025, 0, 6);

/** The `n`th placeholder game, which is the same game every time it is asked for. */
export function tileAt(n: number): Tile {
    return {
        id: `${PREFIX}${String(n)}`,
        title: `${WORDS[n % WORDS.length] ?? ''}'s ${THINGS[(n * 7) % THINGS.length] ?? ''}`,
        creator: WORDS[(n * 5) % WORDS.length] ?? '',
        playing: ((n * 7919) % 9000) + 12,
        hue: (n * 47) % 360,
    };
}

/** The index a placeholder id was made from, or `undefined` for an id this module never made. */
export function placeholderIndex(id: string): number | undefined {
    const match = /^game-(\d{1,9})$/u.exec(id);
    return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** A hue for any id at all, so a real game still gets art of its own. */
export function hueOf(id: string): number {
    let hash = 0;
    for (const char of id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
    return hash;
}

/** The page facts of the `n`th placeholder game, consistent with its tile. */
export function placeholderDetail(n: number): PlaceholderFacts {
    const tile = tileAt(n);
    const genre = GENRES[(n * 3) % GENRES.length] ?? 'Adventure';
    const capacity = CAPACITIES[n % CAPACITIES.length] ?? 12;
    const created = EPOCH + ((n * 37) % 540) * DAY_MS;
    const likes = ((n * 4099) % 48_000) + 900;
    return {
        description: [
            `Welcome to ${tile.title}! ${tile.creator} built this ${genre.toLowerCase()} one block at a time, and it is still growing.`,
            'Explore with friends, find every secret corner, and come back often: the world changes with every update.',
        ].join('\n\n'),
        genre,
        favorites: ((n * 6151) % 90_000) + 250,
        visits: tile.playing * (((n * 13) % 400) + 180),
        capacity,
        likes,
        dislikes: Math.round(likes * (((n * 7) % 22) + 4) * 0.01),
        createdAt: new Date(created).toISOString(),
        updatedAt: new Date(created + (((n * 11) % 120) + 1) * DAY_MS).toISOString(),
        servers: Array.from({ length: (n % 4) + 2 }, (_, slot) => ({
            id: `server-${String(slot + 1)}`,
            players: Math.max(1, capacity - ((n + slot * 5) % capacity)),
            capacity,
        })),
    };
}

/** Games to suggest beside the game `id` titled `title`, never one that reads as it. */
export function suggestionsFor(id: string, title: string, count: number): Tile[] {
    const seed = placeholderIndex(id) ?? hueOf(id);
    const tiles: Tile[] = [];
    for (let step = 1; tiles.length < count; step += 1) {
        const tile = tileAt((seed * 17 + step * 29) % 5000);
        // Titles repeat across placeholders, and a suggestion named like this page reads as itself.
        if (tile.id !== id && tile.title !== title) tiles.push(tile);
    }
    return tiles;
}
