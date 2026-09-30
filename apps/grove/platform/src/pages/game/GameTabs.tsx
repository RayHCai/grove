import { useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Button, Panel, Progress, SectionTitle } from '@grove/ui';
import type { GameDetail } from '../../catalog/detail';
import { formatDate } from '../date';
import { formatCount, UNCOUNTED } from './format';

const TABS = [
    { id: 'about', label: 'About' },
    { id: 'servers', label: 'Servers' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export interface GameTabsProps {
    detail: GameDetail;
}

/** What the game is and where it is running, one tab at a time. */
export function GameTabs({ detail }: GameTabsProps): React.JSX.Element {
    const [open, setOpen] = useState<TabId>('about');
    const tabs = useRef<(HTMLButtonElement | null)[]>([]);
    const base = useId();

    // The arrow keys move between tabs and Tab moves past them, which is what a tablist promises.
    function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
        const last = TABS.length - 1;
        const next =
            event.key === 'ArrowRight'
                ? (index + 1) % TABS.length
                : event.key === 'ArrowLeft'
                  ? (index + last) % TABS.length
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? last
                      : undefined;
        const tab = next === undefined ? undefined : TABS[next];
        if (next === undefined || tab === undefined) return;
        event.preventDefault();
        setOpen(tab.id);
        tabs.current[next]?.focus();
    }

    return (
        <section className="gametabs">
            <div className="gametabs__list" role="tablist" aria-label="About this game">
                {TABS.map((tab, index) => (
                    <button
                        key={tab.id}
                        ref={(node) => {
                            tabs.current[index] = node;
                        }}
                        type="button"
                        role="tab"
                        id={`${base}-${tab.id}-tab`}
                        className="gametabs__tab"
                        aria-selected={open === tab.id}
                        aria-controls={open === tab.id ? `${base}-${tab.id}` : undefined}
                        tabIndex={open === tab.id ? 0 : -1}
                        onClick={() => setOpen(tab.id)}
                        onKeyDown={(event) => onKeyDown(event, index)}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>
            <Panel
                className="gametabs__panel"
                role="tabpanel"
                id={`${base}-${open}`}
                aria-labelledby={`${base}-${open}-tab`}
                tabIndex={0}
            >
                {open === 'about' ? <About detail={detail} /> : <Servers detail={detail} />}
            </Panel>
        </section>
    );
}

function About({ detail }: { detail: GameDetail }): React.JSX.Element {
    const stats: [string, string][] = [
        ['Active', formatCount(detail.playing)],
        ['Favorites', formatCount(detail.favorites)],
        ['Visits', formatCount(detail.visits)],
        ['Created', formatDate(detail.createdAt)],
        [
            'Updated',
            detail.updatedAt === undefined ? 'Never published' : formatDate(detail.updatedAt),
        ],
        ['Server size', detail.capacity === undefined ? UNCOUNTED : String(detail.capacity)],
        ['Genre', detail.genre ?? UNCOUNTED],
        ['Visibility', detail.game?.visibility ?? 'public'],
    ];

    return (
        <div className="gameabout">
            <SectionTitle>Description</SectionTitle>
            <div className="gameabout__text">
                {detail.description === undefined ? (
                    <p className="gameabout__empty">
                        {detail.creator} has not written a description yet.
                    </p>
                ) : (
                    detail.description
                        .split('\n\n')
                        .map((paragraph) => <p key={paragraph}>{paragraph}</p>)
                )}
            </div>
            <dl className="gamestats">
                {stats.map(([term, value]) => (
                    <div key={term} className="gamestats__item">
                        <dt className="gamestats__term">{term}</dt>
                        <dd className="gamestats__value">{value}</dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}

function Servers({ detail }: { detail: GameDetail }): React.JSX.Element {
    if (detail.servers === undefined) {
        return (
            <div className="gameservers">
                <SectionTitle subline="Play puts you in a server with room; there is no list of running servers to read.">
                    Servers
                </SectionTitle>
            </div>
        );
    }

    return (
        <div className="gameservers">
            <SectionTitle subline="Every copy of this game running right now.">
                Servers
            </SectionTitle>
            <ul className="gameservers__list">
                {detail.servers.map((server) => (
                    <li key={server.id}>
                        <Panel className="server">
                            <Progress
                                className="server__fill"
                                label={`${String(server.players)} of ${String(server.capacity)} people`}
                                value={server.players}
                                max={server.capacity}
                            />
                            <Button
                                size="sm"
                                aria-disabled
                                title="A sample game has no servers to join"
                            >
                                Join
                            </Button>
                        </Panel>
                    </li>
                ))}
            </ul>
        </div>
    );
}
