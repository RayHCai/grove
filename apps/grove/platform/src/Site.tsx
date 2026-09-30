import { useEffect, useRef } from 'react';
import { Splash, Tilestrip } from '@grove/ui';
import { SiteHeader } from './chrome/SiteHeader';
import { ForgotPassword } from './pages/ForgotPassword';
import { GamePage } from './pages/GamePage';
import { Games } from './pages/Games';
import { Home } from './pages/Home';
import { Landing } from './pages/Landing';
import { NotFound } from './pages/NotFound';
import { Profile } from './pages/Profile';
import { ResetPassword } from './pages/ResetPassword';
import { SignIn } from './pages/SignIn';
import { SignUp } from './pages/SignUp';
import { needsAnonymity, needsSession, type Route } from './router/routes';
import { replace, useRoute, useRouteFocus } from './router/useRoute';
import { useSession } from './session/SessionProvider';
import type { Session } from './session/SessionProvider';
import { UNFINISHED } from './unfinished';

/** The way back the editor asked for, on the two pages that carry one. */
function returnOf(route: Route): string | undefined {
    return route.at === 'sign-in' || route.at === 'sign-up' ? route.returnTo : undefined;
}

function pageFor(route: Route, session: Session): React.JSX.Element {
    switch (route.at) {
        case 'sign-in':
            return <SignIn returnTo={route.returnTo} />;
        case 'sign-up':
            return <SignUp returnTo={route.returnTo} />;
        case 'forgot-password':
            return <ForgotPassword />;
        case 'reset-password':
            return <ResetPassword token={route.token} />;
        case 'games':
            return <Games />;
        case 'game':
            // Keyed, so going from one game's page to another starts the second one fresh.
            return <GamePage key={route.gameId} gameId={route.gameId} />;
        case 'profile':
            // The gate below has already established there is a session; this is the narrowing.
            return session.at === 'signed-in' ? (
                <Profile account={session.account} />
            ) : (
                <Splash busy note="One moment…" />
            );
        case 'missing':
            return <NotFound path={route.path} />;
        default:
            // The front page browses made-up games until there is a listing of real ones to ask.
            return session.at === 'signed-in' && UNFINISHED ? <Home /> : <Landing />;
    }
}

/**
 * The page the address bar names, with the chrome around it.
 *
 * The gates are here rather than in the pages: whether a route needs a session is a fact about the
 * route, and a page that had to check for itself is a page that can forget to.
 */
export function Site(): React.JSX.Element {
    const route = useRoute();
    useRouteFocus(route);
    const { session, openEditor } = useSession();
    // A tab that is already leaving must not be sent again: the crossing is a navigation, and a
    // test that hands in its own `navigate` does not actually leave.
    const crossing = useRef(false);

    const returnTo = returnOf(route);
    const turnedAway = session.at === 'anonymous' && needsSession(route);
    // Somebody the editor sent here who already holds a session has nothing to sign in to: the
    // editor will read the same cookie they are carrying, so they go straight back.
    const crossBack = session.at === 'signed-in' && needsAnonymity(route) && returnTo !== undefined;
    const alreadyIn = session.at === 'signed-in' && needsAnonymity(route) && returnTo === undefined;

    useEffect(() => {
        // Replaced rather than pushed: somebody bounced off a page they could not see should not
        // have to click back twice to get past it.
        if (turnedAway) replace({ at: 'sign-in', returnTo: undefined });
        else if (alreadyIn) replace({ at: 'landing' });
    }, [turnedAway, alreadyIn]);

    useEffect(() => {
        if (!crossBack || crossing.current) return;
        crossing.current = true;
        openEditor(returnTo);
    }, [crossBack, returnTo, openEditor]);

    function body(): React.JSX.Element {
        if (session.at === 'loading') return <Splash busy note="One moment…" />;
        if (crossBack) return <Splash busy note="Taking you back to the editor…" />;
        if (turnedAway || alreadyIn) return <Splash busy note="One moment…" />;
        return pageFor(route, session);
    }

    return (
        <>
            <Tilestrip className="site__strip" />
            <SiteHeader route={route} />
            {body()}
        </>
    );
}
