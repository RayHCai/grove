import { useCallback, useEffect, useRef, useState } from 'react';
import { tileAt } from '../catalog/placeholder';
import type { Tile } from '../catalog/placeholder';
import { Shelf } from '../catalog/Shelf';

/**
 * What a signed-in visitor sees at `/`: every public game, in rows to browse.
 *
 * Placeholder data throughout: there is no listing of public games to ask yet, so the rows are
 * made up from their index and the tiles by `tileAt`; the real listing slots in where `rowAt` is.
 */

interface Row {
    id: string;
    title: string;
    games: Tile[];
}

const ROW_TITLES = [
    'Recommended for you',
    'Popular right now',
    'Made by friends',
    'New and rising',
    'Obbies',
    'Roleplay',
    'Tycoons',
    'Racing',
    'Puzzles',
    'Hangouts',
];

/** How many rows one more scroll to the bottom adds. */
const ROWS_PER_PAGE = 4;
const GAMES_PER_ROW = 14;

function rowAt(index: number): Row {
    return {
        id: `row-${String(index)}`,
        title: ROW_TITLES[index % ROW_TITLES.length] ?? 'More games',
        games: Array.from({ length: GAMES_PER_ROW }, (_, slot) =>
            tileAt(index * GAMES_PER_ROW + slot),
        ),
    };
}

export function Home(): React.JSX.Element {
    const [rows, setRows] = useState<Row[]>(() =>
        Array.from({ length: ROWS_PER_PAGE }, (_, index) => rowAt(index)),
    );
    const sentinel = useRef<HTMLDivElement>(null);

    const more = useCallback(() => {
        setRows((held) => [
            ...held,
            ...Array.from({ length: ROWS_PER_PAGE }, (_, index) => rowAt(held.length + index)),
        ]);
    }, []);

    useEffect(() => {
        const target = sentinel.current;
        // Absent under jsdom; the page is still whole, it just stops at the first rows.
        if (target === null || typeof IntersectionObserver === 'undefined') return;
        const watcher = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) more();
            },
            { rootMargin: '400px 0px' },
        );
        watcher.observe(target);
        return () => watcher.disconnect();
    }, [more]);

    return (
        <main className="home">
            {rows.map((row) => (
                <Shelf key={row.id} id={row.id} title={row.title} games={row.games} />
            ))}
            <div ref={sentinel} className="home__sentinel" aria-hidden="true" />
        </main>
    );
}
