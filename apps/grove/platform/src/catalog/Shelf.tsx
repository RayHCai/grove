import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRightIcon } from '@grove/ui';
import { Link } from '../router/Link';
import type { Tile } from './placeholder';

export interface ShelfProps {
    /** Unique on the page; the heading's id is made from it. */
    id: string;
    title: string;
    games: Tile[];
}

const count = new Intl.NumberFormat('en', { notation: 'compact' });

/** One row: a title, and a strip of tiles that scrolls sideways a page at a time. */
export function Shelf({ id, title, games }: ShelfProps): React.JSX.Element {
    const strip = useRef<HTMLUListElement>(null);
    const [edges, setEdges] = useState({ start: true, end: false });

    const measure = useCallback(() => {
        const el = strip.current;
        if (el === null) return;
        setEdges({
            start: el.scrollLeft <= 1,
            end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
        });
    }, []);

    useEffect(() => {
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [measure]);

    function page(direction: 1 | -1): void {
        const el = strip.current;
        if (el === null) return;
        el.scrollBy({ left: direction * el.clientWidth * 0.9, behavior: 'smooth' });
    }

    const headingId = `${id}-title`;

    return (
        <section className="shelf" aria-labelledby={headingId}>
            <header className="shelf__head">
                <h2 id={headingId} className="shelf__title">
                    {title}
                </h2>
                <div className="shelf__nav">
                    <button
                        type="button"
                        className="shelf__arrow shelf__arrow--back"
                        aria-label={`Scroll ${title} back`}
                        disabled={edges.start}
                        onClick={() => page(-1)}
                    >
                        <ChevronRightIcon size={18} />
                    </button>
                    <button
                        type="button"
                        className="shelf__arrow"
                        aria-label={`Scroll ${title} forward`}
                        disabled={edges.end}
                        onClick={() => page(1)}
                    >
                        <ChevronRightIcon size={18} />
                    </button>
                </div>
            </header>
            <ul className="shelf__strip" ref={strip} onScroll={measure}>
                {games.map((game) => (
                    <li key={game.id} className="tile">
                        <Link to={{ at: 'game', gameId: game.id }} className="tile__link">
                            <div
                                className="tile__art"
                                style={{ '--tile-hue': game.hue } as React.CSSProperties}
                                aria-hidden="true"
                            />
                            <p className="tile__title">{game.title}</p>
                            <p className="tile__meta">
                                {game.creator} · {count.format(game.playing)} playing
                            </p>
                        </Link>
                    </li>
                ))}
            </ul>
        </section>
    );
}
