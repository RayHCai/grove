import { useState } from 'react';
import { ChevronRightIcon, IconButton } from '@grove/ui';

/** How many pictures a game has; each is its art at another hue and time of day. */
const SHOTS = 4;

export interface GameMediaProps {
    title: string;
    hue: number;
}

/** The art one picture paints, varied per shot so the strip reads as four different scenes. */
function artOf(hue: number, shot: number): React.CSSProperties {
    return {
        '--art-hue': hue + shot * 53,
        '--art-sun': `${String(14 + shot * 23)}%`,
        '--art-hill': `${String(shot % 2 === 0 ? 30 : 40)}%`,
    } as React.CSSProperties;
}

/** The big picture, a step either way, and the strip of every picture under it. */
export function GameMedia({ title, hue }: GameMediaProps): React.JSX.Element {
    const [shown, setShown] = useState(0);
    const step = (by: number): void => setShown((at) => (at + by + SHOTS) % SHOTS);

    return (
        <section className="gamemedia" aria-roledescription="carousel" aria-label={title}>
            <div className="gamemedia__stage">
                <div
                    className="gameart"
                    style={artOf(hue, shown)}
                    role="img"
                    aria-label={`${title}, picture ${String(shown + 1)} of ${String(SHOTS)}`}
                />
                <IconButton
                    className="gamemedia__step gamemedia__step--back"
                    label="Previous picture"
                    onClick={() => step(-1)}
                >
                    <ChevronRightIcon />
                </IconButton>
                <IconButton
                    className="gamemedia__step gamemedia__step--next"
                    label="Next picture"
                    onClick={() => step(1)}
                >
                    <ChevronRightIcon />
                </IconButton>
            </div>
            <div className="gamemedia__thumbs">
                {Array.from({ length: SHOTS }, (_, shot) => (
                    <button
                        key={shot}
                        type="button"
                        className="gamemedia__thumb"
                        aria-label={`Show picture ${String(shot + 1)}`}
                        aria-pressed={shot === shown}
                        onClick={() => setShown(shot)}
                    >
                        <span className="gameart" style={artOf(hue, shot)} />
                    </button>
                ))}
            </div>
        </section>
    );
}
