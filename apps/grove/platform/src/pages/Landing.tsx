import { useState } from 'react';
import { Button } from '@grove/ui';
import type { ReactNode } from 'react';
import { messageOf } from '../api/messages';
import { go } from '../router/useRoute';
import { useSession } from '../session/SessionProvider';

/**
 * A button that bobs on its own.
 *
 * The bob is on this wrapper rather than on the button because a running animation beats a rule,
 * and `.pg-btn:active` is a transform: animating the button itself is a button that cannot be
 * pressed down.
 */
function Floating({ children }: { children: ReactNode }): React.JSX.Element {
    return <span className="hero__float pg-float">{children}</span>;
}

/** The front door: what Grove is, and the two ways in, on one screenful. */
export function Landing(): React.JSX.Element {
    const { session, openEditor } = useSession();
    const [refusal, setRefusal] = useState<string | undefined>(undefined);
    const [leaving, setLeaving] = useState(false);

    async function toEditor(): Promise<void> {
        setLeaving(true);
        setRefusal(undefined);
        try {
            openEditor();
        } catch (failure) {
            setRefusal(messageOf(failure, 'The editor could not be opened. Try again.'));
            setLeaving(false);
        }
    }

    return (
        <main className="landing">
            <section className="hero">
                <div className="hero__body">
                    <h1 className="hero__title">Multiplayer, in a tab.</h1>
                    <p className="hero__lede">
                        You write the game. Grove runs the server and gives you a link to share.
                    </p>
                </div>

                <div className="hero__side">
                    <div className="hero__actions">
                        {session.at === 'signed-in' ? (
                            <>
                                <Floating>
                                    <Button
                                        className="hero__cta"
                                        aria-busy={leaving}
                                        aria-disabled={leaving}
                                        onClick={() => void toEditor()}
                                    >
                                        {leaving ? 'Opening the editor…' : 'Open the editor'}
                                    </Button>
                                </Floating>
                                <Floating>
                                    <Button onClick={() => go({ at: 'games' })}>Your games</Button>
                                </Floating>
                            </>
                        ) : (
                            <>
                                <Floating>
                                    <Button
                                        className="hero__cta"
                                        onClick={() => go({ at: 'sign-up', returnTo: undefined })}
                                    >
                                        Start building
                                    </Button>
                                </Floating>
                                <Floating>
                                    <Button
                                        onClick={() => go({ at: 'sign-in', returnTo: undefined })}
                                    >
                                        Sign in
                                    </Button>
                                </Floating>
                            </>
                        )}
                    </div>

                    {refusal !== undefined && (
                        <p className="hero__refusal" role="alert">
                            {refusal}
                        </p>
                    )}
                </div>
            </section>
        </main>
    );
}
