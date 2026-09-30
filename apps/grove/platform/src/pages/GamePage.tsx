import { useEffect, useEffectEvent, useState } from 'react';
import {
    Badge,
    Button,
    Eyebrow,
    HeartIcon,
    IconButton,
    Panel,
    PlayIcon,
    Progress,
    SectionTitle,
    Tag,
    ThumbDownIcon,
    ThumbUpIcon,
    messageOf,
} from '@grove/ui';
import type { Game } from '@grove/api-contract';
import { isLapsedSession } from '../api/client';
import { heldGame, placeholderGame } from '../catalog/detail';
import type { GameDetail } from '../catalog/detail';
import { suggestionsFor } from '../catalog/placeholder';
import { Shelf } from '../catalog/Shelf';
import { playRefusal } from '../player/refusal';
import { ButtonLink } from '../router/Link';
import { useAction } from '../session/useAction';
import { useSession } from '../session/SessionProvider';
import { GameMedia } from './game/GameMedia';
import { GameTabs } from './game/GameTabs';
import { UNFINISHED } from '../unfinished';
import { formatCount } from './game/format';

type Load =
    | { at: 'loading' }
    | { at: 'shown'; detail: GameDetail }
    | { at: 'absent' }
    | { at: 'failed'; message: string };

const SUGGESTIONS = 14;

/** Why a control is drawn but cannot be pressed: nothing on the service keeps what it would say. */
const NOT_OPEN = 'Not open yet';

export interface GamePageProps {
    gameId: string;
}

/**
 * One game: its pictures, who made it and the way in, then what it is and where it is running.
 *
 * A placeholder id is answered on the spot. Any other id is looked for among the viewer's own
 * games, because the service has no read of one game for anybody but the one who owns it.
 */
export function GamePage({ gameId }: GamePageProps): React.JSX.Element {
    const { api, session, lapsed } = useSession();
    const [sample] = useState(() => (UNFINISHED ? placeholderGame(gameId) : undefined));
    const [load, setLoad] = useState<Load>(() =>
        sample === undefined ? { at: 'loading' } : { at: 'shown', detail: sample },
    );
    const [attempt, setAttempt] = useState(0);

    const creator = session.at === 'signed-in' ? session.account.displayName : '';

    const settle = useEffectEvent((games: Game[]) => {
        const owned = games.find((game) => game.gameId === gameId);
        setLoad(
            owned === undefined
                ? { at: 'absent' }
                : { at: 'shown', detail: heldGame(owned, creator) },
        );
    });
    const refused = useEffectEvent((failure: unknown) => {
        if (isLapsedSession(failure)) {
            lapsed();
            return;
        }
        setLoad({ at: 'failed', message: messageOf(failure, 'This game could not be looked up.') });
    });

    useEffect(() => {
        if (sample !== undefined) return undefined;
        // An answer that lands after this effect was torn down belongs to nobody.
        let live = true;
        api.games().then(
            (games) => {
                if (live) settle(games);
            },
            (failure: unknown) => {
                if (live) refused(failure);
            },
        );
        return () => {
            live = false;
        };
    }, [api, sample, attempt]);

    function retry(): void {
        setLoad({ at: 'loading' });
        setAttempt((count) => count + 1);
    }

    const title = load.at === 'shown' ? load.detail.title : undefined;
    useEffect(() => {
        if (title !== undefined) document.title = `${title} · Grove`;
    }, [title]);

    switch (load.at) {
        case 'loading':
            return (
                <main className="gamepage">
                    <p className="zone__note" role="status" aria-busy="true">
                        Looking up this game…
                    </p>
                </main>
            );
        case 'failed':
            return (
                <main className="gamepage">
                    <Panel className="zone__failure">
                        <p role="alert">{load.message}</p>
                        <Button onClick={retry}>Try again</Button>
                    </Panel>
                </main>
            );
        case 'absent':
            return (
                <main className="gamepage">
                    <Panel className="zone__empty">
                        <SectionTitle as="h1">No game to show</SectionTitle>
                        <p>
                            This is not one of your games, and Grove can only look up the games you
                            made.
                        </p>
                        <ButtonLink variant="primary" to={{ at: 'games' }}>
                            Your games
                        </ButtonLink>
                    </Panel>
                </main>
            );
        default:
            return <GameView detail={load.detail} />;
    }
}

interface GameViewProps {
    detail: GameDetail;
}

/** The page once there is a game to show. */
function GameView({ detail }: GameViewProps): React.JSX.Element {
    const { api, openPlayer } = useSession();
    const action = useAction();
    const busy = action.busy;
    const refusal = action.refusal;
    const game = detail.game;

    function play(): void {
        if (game === undefined) return;
        void action.run(async () => {
            try {
                const session = await api.play(game.gameId);
                openPlayer({ gameId: game.gameId, session });
                return undefined;
            } catch (failure) {
                if (isLapsedSession(failure)) throw failure;
                return playRefusal(failure, detail.title);
            }
        }, 'That game could not be started. Try again.');
    }

    return (
        <main className="gamepage">
            <div className="gamehero">
                <GameMedia title={detail.title} hue={detail.hue} />

                <Panel as="section" className="gameinfo" aria-labelledby="gameinfo-title">
                    {detail.genre !== undefined && <Eyebrow>{detail.genre}</Eyebrow>}
                    <h1 id="gameinfo-title" className="gameinfo__title">
                        {detail.title}
                    </h1>
                    <p className="gameinfo__by">
                        By <span className="gameinfo__creator">{detail.creator}</span>
                        {game !== undefined && <Badge icon="sprout">Yours</Badge>}
                    </p>
                    {game !== undefined && (
                        <p className="gameinfo__tags">
                            <Tag>{game.visibility}</Tag>
                            {game.publishedAt === null && <Tag>Not published</Tag>}
                        </p>
                    )}

                    <Button
                        variant="primary"
                        className="gameinfo__play"
                        icon={<PlayIcon />}
                        aria-busy={busy}
                        aria-disabled={busy || game === undefined}
                        aria-describedby={game === undefined ? 'gameinfo-sample' : undefined}
                        onClick={play}
                    >
                        {busy ? 'Joining…' : 'Play'}
                    </Button>
                    {game === undefined && (
                        <p id="gameinfo-sample" className="gameinfo__note">
                            A sample game: there is nothing to join yet.
                        </p>
                    )}
                    {refusal !== undefined && (
                        <p className="zone__refusal" role="alert">
                            {refusal}
                        </p>
                    )}

                    {/* Nothing on the service keeps favourites or votes, nor suggests a thing. */}
                    {UNFINISHED && (
                        <>
                            <div className="gameinfo__social">
                                <span className="gameinfo__counter">
                                    <IconButton
                                        size="sm"
                                        label="Favorite"
                                        title={NOT_OPEN}
                                        disabled
                                    >
                                        <HeartIcon />
                                    </IconButton>
                                    {formatCount(detail.favorites)}
                                </span>
                            </div>

                            <Votes likes={detail.likes} dislikes={detail.dislikes} />
                        </>
                    )}
                </Panel>
            </div>

            <GameTabs detail={detail} />

            {UNFINISHED && (
                <Shelf
                    id="suggested"
                    title="You might also like"
                    games={suggestionsFor(detail.gameId, detail.title, SUGGESTIONS)}
                />
            )}
        </main>
    );
}

interface VotesProps {
    likes: number | undefined;
    dislikes: number | undefined;
}

/** Thumbs either side of the share of players who liked it. */
function Votes({ likes, dislikes }: VotesProps): React.JSX.Element {
    return (
        <div className="gamevotes">
            {likes !== undefined && dislikes !== undefined && likes + dislikes > 0 ? (
                <Progress label="Liked by players" value={likes} max={likes + dislikes} />
            ) : (
                <p className="gameinfo__note">No ratings yet.</p>
            )}
            <div className="gamevotes__row">
                <span className="gameinfo__counter">
                    <IconButton size="sm" label="Like" title={NOT_OPEN} disabled>
                        <ThumbUpIcon />
                    </IconButton>
                    {formatCount(likes)}
                </span>
                <span className="gameinfo__counter">
                    {formatCount(dislikes)}
                    <IconButton size="sm" label="Dislike" title={NOT_OPEN} disabled>
                        <ThumbDownIcon />
                    </IconButton>
                </span>
            </div>
        </div>
    );
}
