import { useEffect, useMemo, useState } from 'react';
import { Button, leaveFor } from '@grove/ui';
import { DESIGN_STAGE, GamePlayer } from '@grove/player';
import type { GameAuthority, GameProject, RefusalReason } from '@grove/player';
import { clearFragment, readHandoff } from './handoff';
import type { Handoff } from './handoff';

export interface AppProps {
    /** The fragment the platform left; a test hands in its own rather than touching the url. */
    fragment?: string;
    /** Where a refused join sends the person back to. */
    platformUrl: string;
    /** How the tab leaves; a test hands in its own rather than navigating. */
    navigate?: (url: string) => void;
}

type Phase =
    | { kind: 'loading' }
    | { kind: 'playing' }
    /** A join that will not happen, with the line a person is shown and where they go next. */
    | { kind: 'refused'; message: string };

export function App({ fragment, platformUrl, navigate }: AppProps): React.JSX.Element {
    // Read once. A fragment that changed under a live session would be a second join in a page
    // already holding one, and the session is what owns the socket.
    const handoff = useMemo(
        () => readHandoff(fragment ?? globalThis.location?.hash ?? ''),
        [fragment],
    );
    const [phase, setPhase] = useState<Phase>(() => opening(handoff));
    // Held across renders: a ready or a refusal rerenders this, and fresh objects each time would
    // read to the surface as a new join to dial.
    const joined = handoff.outcome === 'joined' ? handoff.handoff.session : undefined;
    const authority = useMemo<GameAuthority | undefined>(
        () =>
            joined === undefined
                ? undefined
                : { kind: 'remote', serverUrl: joined.serverUrl, ticket: joined.ticket },
        [joined],
    );
    const project = useMemo<GameProject | undefined>(
        () =>
            joined === undefined
                ? undefined
                : { projectId: joined.projectId, projectHash: joined.projectHash },
        [joined],
    );

    useEffect(() => {
        if (handoff.outcome !== 'joined' || fragment !== undefined) return;
        clearFragment(globalThis.location, globalThis.history);
    }, [handoff, fragment]);

    if (authority === undefined || project === undefined) {
        return (
            <Refused message={refusalFor(handoff)} platformUrl={platformUrl} navigate={navigate} />
        );
    }
    if (phase.kind === 'refused') {
        return <Refused message={phase.message} platformUrl={platformUrl} navigate={navigate} />;
    }

    return (
        <main className="player">
            {/* Mounted under the loading screen rather than after it: the session builds a
                renderer and dials while this is on screen, and swapping the tree when it goes
                live would tear that renderer down and start the join again. */}
            <GamePlayer
                authority={authority}
                project={project}
                name="Player"
                design={DESIGN_STAGE}
                onReady={() => setPhase({ kind: 'playing' })}
                onRefused={(reason, message) =>
                    setPhase({ kind: 'refused', message: textFor(reason, message) })
                }
            />
            {phase.kind === 'loading' && <Loading />}
        </main>
    );
}

function Loading(): React.JSX.Element {
    return (
        <div className="player__loading" role="status">
            <p>Loading the game…</p>
        </div>
    );
}

function Refused({
    message,
    platformUrl,
    navigate,
}: {
    message: string;
    platformUrl: string;
    navigate: ((url: string) => void) | undefined;
}): React.JSX.Element {
    return (
        <main className="player player--refused">
            <div role="alert">
                <p>{message}</p>
                <Button onClick={() => (navigate ?? leaveFor)(platformUrl)}>Back to Grove</Button>
            </div>
        </main>
    );
}

function opening(handoff: Handoff): Phase {
    return handoff.outcome === 'joined'
        ? { kind: 'loading' }
        : { kind: 'refused', message: refusalFor(handoff) };
}

function refusalFor(handoff: Handoff): string {
    return handoff.outcome === 'absent'
        ? 'This page is opened from a game on Grove, not on its own.'
        : 'That link is not one this page can read. Try starting the game again.';
}

/**
 * What a person is told, which is never the token.
 *
 * `version` is the one worth spelling out: it means the world moved on while this tab sat on the
 * link, and starting again is what fixes it, where a full game is a thing to wait out.
 */
function textFor(reason: RefusalReason, message: string): string {
    switch (reason) {
        case 'version':
            return 'This game was updated while you were joining. Start it again to play the new version.';
        case 'full':
            return 'This game is full right now. Try again in a minute.';
        case 'ticket':
            return 'That link has expired. Start the game again from Grove.';
        default:
            return message;
    }
}
