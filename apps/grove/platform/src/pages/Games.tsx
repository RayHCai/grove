import { useState } from 'react';
import {
    Badge,
    Button,
    EyeIcon,
    PlusIcon,
    IconButton,
    Panel,
    SettingsIcon,
    Tag,
    TextInput,
    TrashIcon,
    VisuallyHidden,
} from '@grove/ui';
import type { Game } from '@grove/api-contract';
import { isLapsedSession } from '../api/client';
import { FormPanel } from '../chrome/FormPanel';
import { SearchField } from '../chrome/SearchField';
import { playRefusal } from '../player/refusal';
import { IconLink } from '../router/Link';
import { useAction } from '../session/useAction';
import { useLoad } from '../session/useLoad';
import { useSession } from '../session/SessionProvider';
import { UNFINISHED } from '../unfinished';
import { formatDate } from './date';

/** The title a game gets when somebody made one without naming it. */
const UNTITLED = 'Untitled game';

/** What one row is in the middle of; every other row stays free to press. */
interface RowDoing {
    gameId: string;
    kind: 'edit' | 'play' | 'delete';
}

/** Every game this creator owns, newest first, each of them a way into the editor. */
export function Games(): React.JSX.Element {
    const { api, openEditor, openPlayer } = useSession();
    const listing = useLoad(() => api.games(), 'Your games could not be listed.', [api]);
    const [naming, setNaming] = useState(false);
    const [title, setTitle] = useState('');
    const [query, setQuery] = useState('');
    const creating = useAction();
    const row = useAction();
    const [doing, setDoing] = useState<RowDoing | null>(null);

    function create(): void {
        void creating.run(async () => {
            const made = await api.createGame(title.trim() === '' ? UNTITLED : title.trim());
            setNaming(false);
            setTitle('');
            listing.update((held = []) => [made, ...held]);
            openEditor({ gameId: made.gameId });
        }, 'That game could not be made. Try again.');
    }

    async function onRow(
        game: Game,
        kind: RowDoing['kind'],
        work: () => Promise<string | undefined | void>,
        fallback: string,
    ): Promise<void> {
        setDoing({ gameId: game.gameId, kind });
        await row.run(work, fallback);
        setDoing(null);
    }

    function remove(game: Game): void {
        // A game is gone for good, files and all, so the owner says so out loud first.
        if (
            !window.confirm(
                `Delete "${game.title}"? Its files go with it, and this cannot be undone.`,
            )
        ) {
            return;
        }
        void onRow(
            game,
            'delete',
            async () => {
                await api.deleteGame(game.gameId);
                listing.update((held = []) => held.filter((each) => each.gameId !== game.gameId));
            },
            'That game could not be deleted. Try again.',
        );
    }

    function edit(game: Game): void {
        // Left set: the tab is on its way to the editor, and nothing on this page comes back.
        setDoing({ gameId: game.gameId, kind: 'edit' });
        row.reset();
        openEditor({ gameId: game.gameId });
    }

    function play(game: Game): void {
        void onRow(
            game,
            'play',
            async () => {
                try {
                    const session = await api.play(game.gameId);
                    openPlayer({ gameId: game.gameId, session });
                    return undefined;
                } catch (failure) {
                    if (isLapsedSession(failure)) throw failure;
                    return playRefusal(failure, game.title);
                }
            },
            'That game could not be started. Try again.',
        );
    }

    const games = listing.state.at === 'loaded' ? listing.state.value : [];
    const newestId = games[0]?.gameId;
    const needle = query.trim().toLowerCase();
    const shown =
        needle === '' ? games : games.filter((game) => game.title.toLowerCase().includes(needle));
    const refusal = row.refusal ?? creating.refusal;

    return (
        <main className="zone">
            <VisuallyHidden as="h1">Your games</VisuallyHidden>
            <header className="zone__head gamesbar">
                <SearchField
                    className="gamesbar__search"
                    label="Search your games"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                />
                {!naming && (
                    <IconButton
                        className="gamesbar__new"
                        variant="primary"
                        label="New game"
                        onClick={() => setNaming(true)}
                    >
                        <PlusIcon />
                    </IconButton>
                )}
            </header>

            {refusal !== undefined && (
                <p className="zone__refusal" role="alert">
                    {refusal}
                </p>
            )}

            {naming && (
                <FormPanel className="newgame" onSubmit={create}>
                    <TextInput
                        label="Game title"
                        className="newgame__field"
                        name="title"
                        maxLength={120}
                        autoFocus
                        hint="You can rename it later."
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                    />
                    <div className="newgame__actions">
                        <Button
                            type="submit"
                            variant="primary"
                            aria-busy={creating.busy}
                            aria-disabled={creating.busy}
                        >
                            {creating.busy ? 'Making it…' : 'Create and open the editor'}
                        </Button>
                        <Button
                            variant="ghost"
                            aria-disabled={creating.busy || undefined}
                            onClick={() => {
                                setNaming(false);
                                setTitle('');
                            }}
                        >
                            Cancel
                        </Button>
                    </div>
                </FormPanel>
            )}

            {listing.state.at === 'loading' && (
                <p className="zone__note" role="status" aria-busy="true">
                    Looking up your games…
                </p>
            )}

            {listing.state.at === 'failed' && (
                <Panel className="zone__failure">
                    <p role="alert">{listing.state.message}</p>
                    <Button onClick={listing.retry}>Try again</Button>
                </Panel>
            )}

            {listing.state.at === 'loaded' && games.length === 0 && !naming && (
                <Panel className="zone__empty">
                    <p>
                        A game starts as one file with a world in it. Make one and the editor opens
                        on it.
                    </p>
                    <Button variant="primary" onClick={() => setNaming(true)}>
                        Make your first game
                    </Button>
                </Panel>
            )}

            {games.length > 0 && (
                <section className="gamelist" aria-label="Your games">
                    {/* Column labels for the rows below, not a table header: each row stays a card. */}
                    <div className="gamelist__labels" aria-hidden="true">
                        <span>Name</span>
                        <span>Created</span>
                        <span>Visibility</span>
                        <span />
                    </div>
                    {shown.length === 0 && (
                        <p className="zone__note">No games match “{query.trim()}”.</p>
                    )}
                    <ul className="gamelist__rows">
                        {shown.map((game) => {
                            const busy = doing?.gameId === game.gameId ? doing.kind : undefined;
                            return (
                                <li key={game.gameId}>
                                    <Panel as="article" className="gamecard">
                                        <div className="gamecard__body">
                                            <h2 className="gamecard__title">{game.title}</h2>
                                            {game.gameId === newestId && (
                                                <Badge icon="sprout">Newest</Badge>
                                            )}
                                        </div>
                                        <span className="gamecard__cell">
                                            {formatDate(game.createdAt)}
                                        </span>
                                        <span className="gamecard__cell">
                                            <Tag>{game.visibility}</Tag>
                                        </span>
                                        <div className="gamecard__actions">
                                            <Button
                                                variant="primary"
                                                size="sm"
                                                aria-busy={busy === 'edit'}
                                                aria-disabled={busy !== undefined}
                                                onClick={() => edit(game)}
                                            >
                                                {busy === 'edit' ? 'Opening…' : 'Open in editor'}
                                            </Button>
                                            <Button
                                                size="sm"
                                                aria-busy={busy === 'play'}
                                                aria-disabled={busy !== undefined}
                                                onClick={() => play(game)}
                                            >
                                                Play
                                            </Button>
                                            {/* Only a published game has a page worth a visit. */}
                                            {game.publishedAt !== null && (
                                                <IconLink
                                                    size="sm"
                                                    label="View game page"
                                                    to={{ at: 'game', gameId: game.gameId }}
                                                >
                                                    <EyeIcon />
                                                </IconLink>
                                            )}
                                            {UNFINISHED && (
                                                <IconButton
                                                    size="sm"
                                                    label="Game settings"
                                                    disabled
                                                >
                                                    <SettingsIcon />
                                                </IconButton>
                                            )}
                                            <IconButton
                                                size="sm"
                                                label="Delete game"
                                                aria-busy={busy === 'delete'}
                                                aria-disabled={busy !== undefined}
                                                onClick={() => remove(game)}
                                            >
                                                <TrashIcon />
                                            </IconButton>
                                        </div>
                                    </Panel>
                                </li>
                            );
                        })}
                    </ul>
                </section>
            )}
        </main>
    );
}
