import { useEffect, useRef, useState } from 'react';
import { Button, Panel, Tilestrip, Wordmark } from '@grove/ui';
import { ProjectFormatError } from '@platform/project';
import { ApiError, isLapsedSession } from '../api/client';
import type { Api } from '../api/client';
import { EditorShell } from '../shell/EditorShell';
import type { EditorShellProps } from '../shell/EditorShell';
import { openGame } from '../workspace/session';
import type { OpenGame } from '../workspace/session';
import { LoadingScreen } from './LoadingScreen';
import type { Step } from './LoadingScreen';
import { signInUrl } from './platform';

type Phase =
    | { at: 'loading'; step: Step }
    | { at: 'leaving' }
    | { at: 'failed'; message: string }
    | { at: 'ready'; opened: OpenGame };

/**
 * Marks that this tab has already been sent to the platform once.
 *
 * Without it, a platform that sends somebody back without a session and an editor that sends them
 * away without one bounce between each other forever, and neither ever says why.
 */
const BOUNCED = 'grove:editor:sent-to-sign-in';

export interface BootProps {
    api: Api;
    /** How this tab leaves for the platform; a test hands in its own rather than navigating. */
    navigate?: ((url: string) => void) | undefined;
    /**
     * How a second tab is opened, answering whether one was. The browser blocks a window nothing
     * clicked for, and a sign-in that never opened has to be said out loud rather than waited for.
     */
    openTab?: ((url: string) => boolean) | undefined;
    /** How the creator is told something they have to act on; a test hands in its own. */
    notify?: ((message: string) => void) | undefined;
    /** How a local world's renderer is built; a test hands in one that needs no GPU. */
    createRenderer?: EditorShellProps['createRenderer'];
}

function messageOf(failure: unknown): string {
    if (failure instanceof ApiError) return failure.message;
    // A manifest this build cannot read is the one failure a creator can act on: it names the
    // member at fault, and a file from a newer editor says so rather than reading as a crash.
    if (failure instanceof ProjectFormatError) return `this game's settings: ${failure.message}`;
    return 'the editor could not open your game';
}

/** Session storage is gone in a private window and throws in a few of them; neither is fatal here. */
function remember(key: string, value: string | undefined): string | undefined {
    try {
        if (value === undefined) {
            const held = window.sessionStorage.getItem(key);
            return held === null ? undefined : held;
        }
        window.sessionStorage.setItem(key, value);
        return value;
    } catch {
        return undefined;
    }
}

function forget(key: string): void {
    try {
        window.sessionStorage.removeItem(key);
    } catch {
        // Nothing to clear is the same outcome as having cleared it.
    }
}

/**
 * Everything that has to be true before there is a workbench to show.
 *
 * The session is a cookie the API set on its own origin, and the platform and this editor are two
 * subdomains of one site — so the browser carries it here by itself and there is nothing to hand
 * over. Asking the service who this is IS reading it: the cookie is `HttpOnly`, so no script on
 * this origin can, which is what keeps it out of reach of everything the editor compiles and runs.
 *
 * There is no signing in here: a password is the platform's business, and somebody the service does
 * not recognise is sent there rather than asked for one.
 */
export function Boot({
    api,
    navigate,
    openTab,
    notify,
    createRenderer,
}: BootProps): React.JSX.Element {
    const [phase, setPhase] = useState<Phase>({ at: 'loading', step: 'session' });
    // StrictMode runs the effect below twice, and the second run would make a second game for a
    // creator who had none.
    const begun = useRef(false);

    function leave(): void {
        setPhase({ at: 'leaving' });
        if (remember(BOUNCED, undefined) === '1') {
            setPhase({
                at: 'failed',
                message: 'signing in did not take. Open the editor from Grove again.',
            });
            return;
        }
        remember(BOUNCED, '1');
        const go = navigate ?? ((url: string) => window.location.assign(url));
        go(signInUrl(new URL(window.location.href)));
    }

    /**
     * A session that lapsed while the workbench was open.
     *
     * This tab stays where it is. There is unsaved work in it, and navigating away to sign in is
     * exactly what would lose it — so the sign-in goes in a second tab, and coming back and saving
     * again is all that is left to do. The browser may refuse a tab nothing clicked for, which is
     * why the address is said out loud when it does.
     */
    function signInBeside(): void {
        const url = signInUrl(new URL(window.location.href));
        const tell = notify ?? ((message: string) => window.alert(message));
        const opened = openTab ?? ((at: string) => window.open(at, '_blank', 'noopener') !== null);

        // Said before the tab opens: an alert is the one thing here a blocked popup cannot swallow.
        tell(
            'Your Grove session has ended. Sign in on the new tab, then save again — nothing on this screen is lost.',
        );
        if (!opened(url)) {
            tell(`The sign-in tab could not be opened. Sign in at ${url}, then save again.`);
        }
    }

    async function open(): Promise<void> {
        try {
            const opened = await openGame(api, (step) => setPhase({ at: 'loading', step }));
            setPhase({ at: 'ready', opened });
        } catch (failure) {
            // A session that lapsed between the check and the first read is not a failure to
            // report; it is the platform's sign-in.
            if (isLapsedSession(failure)) {
                leave();
                return;
            }
            setPhase({ at: 'failed', message: messageOf(failure) });
        }
    }

    async function start(): Promise<void> {
        setPhase({ at: 'loading', step: 'session' });
        try {
            if ((await api.session()) === undefined) {
                leave();
                return;
            }
        } catch (failure) {
            // Every refusal the service named while answering for the session is the same answer:
            // this browser is not carrying one the editor can work behind, whatever the body said.
            // A service nobody could reach named nothing, and is the one failure left to report —
            // sending the tab into a network that is down would take the Try again with it.
            if (failure instanceof ApiError && failure.code !== 'unreachable') {
                leave();
                return;
            }
            setPhase({ at: 'failed', message: messageOf(failure) });
            return;
        }
        // Whatever sent this tab away last time worked, so the next refusal is a fresh one.
        forget(BOUNCED);
        await open();
    }

    useEffect(() => {
        if (begun.current) return;
        begun.current = true;
        void start();
    }, []);

    if (phase.at === 'loading') return <LoadingScreen step={phase.step} />;

    if (phase.at === 'leaving') {
        return (
            <main className="boot">
                <Tilestrip />
                <Panel className="boot__card" aria-busy="true">
                    <Wordmark />
                    <p className="boot__note" role="status">
                        Taking you to Grove to sign in…
                    </p>
                </Panel>
            </main>
        );
    }

    if (phase.at === 'failed') {
        return (
            <main className="boot">
                <Tilestrip />
                <Panel className="boot__card">
                    <Wordmark />
                    <p className="boot__refusal" role="alert">
                        {phase.message}
                    </p>
                    <Button
                        variant="primary"
                        onClick={() => {
                            forget(BOUNCED);
                            void start();
                        }}
                    >
                        Try again
                    </Button>
                </Panel>
            </main>
        );
    }

    return (
        <EditorShell
            api={api}
            opened={phase.opened}
            onSessionLapsed={signInBeside}
            createRenderer={createRenderer}
        />
    );
}
