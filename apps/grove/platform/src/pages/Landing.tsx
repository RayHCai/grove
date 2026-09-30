import { useState } from 'react';
import { Button } from '@grove/ui';
import type { ReactNode } from 'react';
import { ButtonLink } from '../router/Link';
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
    const [leaving, setLeaving] = useState(false);

    return (
        <main className="landing">
            <section className="hero">
                <div className="hero__body">
                    <h1 className="hero__title">Creativity unleashed</h1>
                    <p className="hero__lede">Your friends. Millions of games. One platform.</p>
                </div>

                <div className="hero__side">
                    <div className="hero__actions">
                        {session.at === 'signed-in' ? (
                            <>
                                <Floating>
                                    <Button
                                        variant="warm"
                                        className="hero__cta"
                                        aria-busy={leaving}
                                        aria-disabled={leaving}
                                        onClick={() => {
                                            setLeaving(true);
                                            openEditor();
                                        }}
                                    >
                                        {leaving ? 'Opening the editor…' : 'Open the editor'}
                                    </Button>
                                </Floating>
                                <Floating>
                                    <ButtonLink to={{ at: 'games' }}>Your games</ButtonLink>
                                </Floating>
                            </>
                        ) : (
                            <>
                                <Floating>
                                    <ButtonLink
                                        variant="warm"
                                        className="hero__cta"
                                        to={{ at: 'sign-up', returnTo: undefined }}
                                    >
                                        Start building
                                    </ButtonLink>
                                </Floating>
                                <Floating>
                                    <ButtonLink to={{ at: 'sign-in', returnTo: undefined }}>
                                        Sign in
                                    </ButtonLink>
                                </Floating>
                            </>
                        )}
                    </div>
                </div>
            </section>
        </main>
    );
}
