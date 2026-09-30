import { HomeIcon, Panel, Wordmark } from '@grove/ui';
import { ButtonLink, Link, navigateInPlace } from '../router/Link';
import { hrefOf, type Route } from '../router/routes';
import { useSession } from '../session/SessionProvider';
import { UNFINISHED } from '../unfinished';
import { ProfileMenu } from './ProfileMenu';
import { SearchField } from './SearchField';

export interface SiteHeaderProps {
    route: Route;
}

/** The header every page carries: the wordmark, where else to go, and the account. */
export function SiteHeader({ route }: SiteHeaderProps): React.JSX.Element {
    const { session } = useSession();

    return (
        <header className="siteheader">
            <Panel className="siteheader__inner" aria-label="Main">
                <Wordmark
                    href={hrefOf({ at: 'landing' })}
                    onClick={(event) => navigateInPlace({ at: 'landing' }, event)}
                />

                {session.at === 'signed-in' && (
                    <>
                        <nav className="sitenav" aria-label="Your Grove">
                            <Link
                                to={{ at: 'landing' }}
                                className="sitenav__link sitenav__link--icon"
                                aria-label="Home"
                                title="Home"
                                aria-current={route.at === 'landing' ? 'page' : undefined}
                            >
                                <HomeIcon size={20} />
                            </Link>
                        </nav>

                        {/* Not wired to anything yet: there is no search endpoint to ask. */}
                        {UNFINISHED && (
                            <form
                                className="sitesearch"
                                role="search"
                                onSubmit={(event) => event.preventDefault()}
                            >
                                <SearchField label="Search Grove" name="q" />
                            </form>
                        )}
                    </>
                )}

                <div className="siteheader__end">
                    {session.at === 'signed-in' && <ProfileMenu />}
                    {session.at === 'anonymous' && (
                        <>
                            <ButtonLink
                                size="sm"
                                variant="ghost"
                                to={{ at: 'sign-in', returnTo: undefined }}
                            >
                                Sign in
                            </ButtonLink>
                            <ButtonLink
                                size="sm"
                                variant="primary"
                                to={{ at: 'sign-up', returnTo: undefined }}
                            >
                                Get started
                            </ButtonLink>
                        </>
                    )}
                </div>
            </Panel>
        </header>
    );
}
