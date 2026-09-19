import { Button, Panel, Wordmark } from '@grove/ui';
import { Link } from '../router/Link';
import { hrefOf, type Route } from '../router/routes';
import { go } from '../router/useRoute';
import { useSession } from '../session/SessionProvider';

export interface SiteHeaderProps {
    route: Route;
}

/** The header every page carries: the wordmark, where else to go, and the account. */
export function SiteHeader({ route }: SiteHeaderProps): React.JSX.Element {
    const { session, signOut } = useSession();

    return (
        <header className="siteheader">
            <Panel className="siteheader__inner" aria-label="Main">
                <Wordmark
                    href={hrefOf({ at: 'landing' })}
                    onClick={(event) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                        event.preventDefault();
                        go({ at: 'landing' });
                    }}
                />

                {session.at === 'signed-in' && (
                    <nav className="sitenav" aria-label="Your Grove">
                        <Link
                            to={{ at: 'games' }}
                            className="sitenav__link"
                            aria-current={route.at === 'games' ? 'page' : undefined}
                        >
                            Games
                        </Link>
                        <Link
                            to={{ at: 'profile' }}
                            className="sitenav__link"
                            aria-current={route.at === 'profile' ? 'page' : undefined}
                        >
                            Profile
                        </Link>
                    </nav>
                )}

                <div className="siteheader__end">
                    {session.at === 'signed-in' && (
                        <>
                            <span className="siteheader__who">{session.account.displayName}</span>
                            <Button size="sm" variant="ghost" onClick={() => void signOut()}>
                                Sign out
                            </Button>
                        </>
                    )}
                    {session.at === 'anonymous' && (
                        <>
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => go({ at: 'sign-in', returnTo: undefined })}
                            >
                                Sign in
                            </Button>
                            <Button
                                size="sm"
                                variant="primary"
                                onClick={() => go({ at: 'sign-up', returnTo: undefined })}
                            >
                                Get started
                            </Button>
                        </>
                    )}
                </div>
            </Panel>
        </header>
    );
}
