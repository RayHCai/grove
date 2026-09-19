import { useEffect, useRef, useState } from 'react';
import { Button, Panel, Tilestrip, Wordmark } from '@grove/ui';
import { ApiError } from '../api/client';
import type { Api } from '../api/client';
import { EditorShell } from '../shell/EditorShell';
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
}

function messageOf(failure: unknown): string {
    return failure instanceof ApiError ? failure.message : 'the editor could not open your game';
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
export function Boot({ api, navigate }: BootProps): React.JSX.Element {
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

    async function open(): Promise<void> {
        try {
            const opened = await openGame(api, (step) => setPhase({ at: 'loading', step }));
            setPhase({ at: 'ready', opened });
        } catch (failure) {
            // A session that lapsed between the check and the first read is not a failure to
            // report; it is the platform's sign-in.
            if (failure instanceof ApiError && failure.code === 'unauthorized') {
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

    return <EditorShell api={api} opened={phase.opened} onSignedOut={leave} />;
}
