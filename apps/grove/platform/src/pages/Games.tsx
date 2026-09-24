import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Eyebrow, Panel, SectionTitle, Tag, TextInput } from '@grove/ui';
import type { Game } from '@grove/api-contract';
import { isLapsedSession, messageOf } from '../api/messages';
import { go } from '../router/useRoute';
import { useSession } from '../session/SessionProvider';
import { formatDate } from './date';

/** The title a game gets when somebody made one without naming it. */
const UNTITLED = 'Untitled game';

type Listing =
    { at: 'loading' } | { at: 'listed'; games: Game[] } | { at: 'failed'; message: string };

/**
 * Every game this creator owns, newest first.
 *
 * The editor opens the newest of them and has no way to be pointed at another, so only the first
 * card offers to open one — a button on the rest would say it opens that game and open a different
 * one.
 */
export function Games(): React.JSX.Element {
    const { api, session, forget, openEditor } = useSession();
    const [listing, setListing] = useState<Listing>({ at: 'loading' });
    const [naming, setNaming] = useState(false);
    const [title, setTitle] = useState('');
    const [refusal, setRefusal] = useState<string | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    // StrictMode runs the effect below twice, and the second run would list the games again.
    const asked = useRef(false);

    const lapsed = useCallback(() => {
        forget();
        go({ at: 'sign-in', returnTo: undefined });
    }, [forget]);

    const load = useCallback(async () => {
        setListing({ at: 'loading' });
        try {
            setListing({ at: 'listed', games: await api.games() });
        } catch (failure) {
            if (isLapsedSession(failure)) {
                lapsed();
                return;
            }
            setListing({
                at: 'failed',
                message: messageOf(failure, 'Your games could not be listed.'),
            });
        }
    }, [api, lapsed]);

    useEffect(() => {
        if (asked.current) return;
        asked.current = true;
        void load();
    }, [load]);

    async function create(): Promise<void> {
        setBusy(true);
        setRefusal(undefined);
        try {
            const made = await api.createGame(title.trim() === '' ? UNTITLED : title.trim());
            setNaming(false);
            setTitle('');
            // Made and then opened, in that order: the new game is now the newest, which is the one
            // the editor opens on.
            setListing({
                at: 'listed',
                games: [made, ...(listing.at === 'listed' ? listing.games : [])],
            });
            openEditor();
        } catch (failure) {
            if (isLapsedSession(failure)) {
                lapsed();
                return;
            }
            setRefusal(messageOf(failure, 'That game could not be made. Try again.'));
        } finally {
            setBusy(false);
        }
    }

    async function edit(): Promise<void> {
        setBusy(true);
        setRefusal(undefined);
        try {
            openEditor();
        } catch (failure) {
            if (isLapsedSession(failure)) {
                lapsed();
                return;
            }
            setRefusal(messageOf(failure, 'The editor could not be opened. Try again.'));
            setBusy(false);
        }
    }

    const games = listing.at === 'listed' ? listing.games : [];
    const newest = games[0];

    return (
        <main className="zone">
            <header className="zone__head">
                <div>
                    <Eyebrow>
                        {session.at === 'signed-in' ? session.account.displayName : 'Your Grove'}
                    </Eyebrow>
                    <SectionTitle
                        as="h1"
                        subline={
                            newest === undefined
                                ? 'Nothing here yet. The first one takes a minute.'
                                : `The editor opens your newest game, ${newest.title}.`
                        }
                    >
                        Your games
                    </SectionTitle>
                </div>
                {!naming && (
                    <Button variant="primary" onClick={() => setNaming(true)}>
                        New game
                    </Button>
                )}
            </header>

            {refusal !== undefined && (
                <p className="zone__refusal" role="alert">
                    {refusal}
                </p>
            )}

            {naming && (
                <Panel
                    as="form"
                    className="newgame"
                    noValidate
                    onSubmit={(event) => {
                        event.preventDefault();
                        void create();
                    }}
                >
                    <TextInput
                        label="Game title"
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
                            aria-busy={busy}
                            aria-disabled={busy}
                        >
                            {busy ? 'Making it…' : 'Create and open the editor'}
                        </Button>
                        <Button
                            variant="ghost"
                            aria-disabled={busy || undefined}
                            onClick={() => {
                                setNaming(false);
                                setTitle('');
                            }}
                        >
                            Cancel
                        </Button>
                    </div>
                </Panel>
            )}

            {listing.at === 'loading' && (
                <p className="zone__note" role="status" aria-busy="true">
                    Looking up your games…
                </p>
            )}

            {listing.at === 'failed' && (
                <Panel className="zone__failure">
                    <p role="alert">{listing.message}</p>
                    <Button onClick={() => void load()}>Try again</Button>
                </Panel>
            )}

            {listing.at === 'listed' && games.length === 0 && !naming && (
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
                <ul className="gamelist">
                    {games.map((game, index) => (
                        <li key={game.gameId}>
                            <Panel as="article" className="gamecard">
                                <div className="gamecard__body">
                                    <h2 className="gamecard__title">{game.title}</h2>
                                    <p className="gamecard__meta">
                                        <Tag>Made {formatDate(game.createdAt, 'short')}</Tag>
                                        {index === 0 && <Badge icon="sprout">Newest</Badge>}
                                    </p>
                                </div>
                                {index === 0 && (
                                    <Button
                                        variant="primary"
                                        size="sm"
                                        aria-busy={busy}
                                        aria-disabled={busy}
                                        onClick={() => void edit()}
                                    >
                                        {busy ? 'Opening…' : 'Open in editor'}
                                    </Button>
                                )}
                            </Panel>
                        </li>
                    ))}
                </ul>
            )}
        </main>
    );
}
