import { useEffect, useMemo, useState } from 'react';
import { Button, leaveFor } from '@grove/ui';
import { DESIGN_STAGE, GamePlayer } from '@grove/player';
import type { GameAuthority, GamePlayerProps, GameProject, RefusalReason } from '@grove/player';
import { clearFragment, readHandoff } from './handoff';
import type { Handoff } from './handoff';
import type { ServerPolicy } from './servers';

export interface AppProps {
    /** The fragment the platform left; a test hands in its own rather than touching the url. */
    fragment?: string;
    /** Which servers a join may name, which a build is told. */
    servers: ServerPolicy;
    /** Where a refused join sends the person back to. */
    platformUrl: string;
    /** How the tab leaves; a test hands in its own rather than navigating. */
    navigate?: (url: string) => void;
    /** How the stage's renderer is built; a test hands in one that needs no GPU. */
    createRenderer?: GamePlayerProps['createRenderer'];
    /** How the server is dialled; a test hands in one that needs no socket. */
    connect?: GamePlayerProps['connect'];
}

type Phase =
    | { kind: 'loading' }
    | { kind: 'playing' }
    /** A join that will not happen, with the line a person is shown and where they go next. */
    | { kind: 'refused'; message: string };

export function App({
    fragment,
    servers,
    platformUrl,
    navigate,
    createRenderer,
    connect,
}: AppProps): React.JSX.Element {
    // Read once. A fragment that changed under a live session would be a second join in a page
    // already holding one, and the session is what owns the socket.
    const handoff = useMemo(
        () => readHandoff(fragment ?? globalThis.location?.hash ?? '', servers),
        [fragment, servers],
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
                onRefused={(reason) => setPhase({ kind: 'refused', message: textFor(reason) })}
                {...(createRenderer === undefined ? {} : { createRenderer })}
                {...(connect === undefined ? {} : { connect })}
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
    switch (handoff.outcome) {
        case 'absent':
            return 'This page is opened from a game on Grove, not on its own.';
        case 'untrusted':
            return 'That link does not lead to a Grove game. Start the game from Grove instead.';
        default:
            return 'That link is not one this page can read. Try starting the game again.';
    }
}

/** What a person is told: never a token, and never the session's own line, which can name a box. */
function textFor(reason: RefusalReason): string {
    switch (reason) {
        case 'version':
            return 'This game was updated while you were joining. Start it again to play the new version.';
        case 'full':
            return 'This game is full right now. Try again in a minute.';
        case 'identity':
            return 'You are already playing this game somewhere else. Close it there, then start it again from Grove.';
        case 'ticket':
            return 'This link may have expired. Start the game again from Grove.';
        case 'bundle':
            return 'This game could not be loaded. Start it again from Grove.';
        case 'renderer':
            return 'This browser could not start the game. Try another browser, or update this one.';
        case 'unreachable':
            return 'The game stopped answering. Start it again from Grove.';
    }
}
