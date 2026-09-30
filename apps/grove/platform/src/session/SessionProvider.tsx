import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Account, PlayHandoff } from '@grove/api-contract';
import { leaveFor } from '@grove/ui';
import type { Api } from '../api/client';
import { editorLink } from '../editor/link';
import { playerLink } from '../player/link';
import { go } from '../router/useRoute';

/** Who is signed in, once the cookie has been asked about. */
export type Session =
    { at: 'loading' } | { at: 'anonymous' } | { at: 'signed-in'; account: Account };

export interface SessionContextValue {
    session: Session;
    /** The service, for the pages that read and write things other than the session itself. */
    api: Api;
    /** `false` is the service's one answer to a wrong address, a wrong password and a lockout. */
    signIn: (email: string, password: string) => Promise<boolean>;
    signUp: (email: string, password: string, displayName: string) => Promise<void>;
    signOut: () => Promise<void>;
    /** Replaces the held account after a page renamed it, so the chrome does not go stale. */
    accountChanged: (account: Account) => void;
    /** Forgets the session without asking the service, for a page that just closed the account. */
    forget: () => void;
    /**
     * What every page does when the service stopped recognising the session mid-visit: forgets it
     * and sends the visitor to sign in, rather than leaving them on a page that can do nothing.
     */
    lapsed: () => void;
    /** Leaves for the editor, optionally back to where it sent somebody from. */
    openEditor: (returnTo?: string | undefined) => void;
    /** Leaves for the player origin, carrying the join the allocator just minted. */
    openPlayer: (handoff: PlayHandoff) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export interface SessionProviderProps {
    api: Api;
    /** How the tab leaves for the editor or a game; a test hands in its own rather than navigating. */
    navigate?: ((url: string) => void) | undefined;
    children: ReactNode;
}

/**
 * The session, read once on the first load and kept for every page after it.
 *
 * Two calls rather than one: `GET /v1/auth/session` is the one route that answers a cookie naming
 * nobody without it being a failure, and it also hands back the CSRF token every write here has to
 * carry, so it runs before the account is read and before any form can be submitted.
 */
export function SessionProvider({
    api,
    navigate,
    children,
}: SessionProviderProps): React.JSX.Element {
    const [session, setSession] = useState<Session>({ at: 'loading' });

    const leave = useCallback((url: string) => (navigate ?? leaveFor)(url), [navigate]);

    useEffect(() => {
        // An answer that lands after this effect was torn down belongs to nobody.
        let live = true;
        const settle = (next: Session): void => {
            if (live) setSession(next);
        };
        void (async () => {
            if ((await api.session()) === undefined) {
                settle({ at: 'anonymous' });
                return;
            }
            settle({ at: 'signed-in', account: await api.me() });
        })().catch(() => {
            // An API nobody can reach is a visitor who is not signed in: the pages behind the gate
            // say so, and the ones in front of it still work.
            settle({ at: 'anonymous' });
        });
        return () => {
            live = false;
        };
    }, [api]);

    const value = useMemo<SessionContextValue>(
        () => ({
            session,
            api,

            signIn: async (email, password) => {
                if ((await api.signIn(email, password)) === undefined) return false;
                setSession({ at: 'signed-in', account: await api.me() });
                return true;
            },

            signUp: async (email, password, displayName) => {
                await api.signUp(email, password, displayName);
                setSession({ at: 'signed-in', account: await api.me() });
            },

            signOut: async () => {
                await api.signOut();
                setSession({ at: 'anonymous' });
            },

            accountChanged: (account) => setSession({ at: 'signed-in', account }),
            forget: () => setSession({ at: 'anonymous' }),
            lapsed: () => {
                setSession({ at: 'anonymous' });
                go({ at: 'sign-in', returnTo: undefined });
            },

            // Nothing is minted and nothing crosses: the session is a cookie on the API origin,
            // and the editor is a subdomain of this same site, so it is already carrying it.
            openEditor: (returnTo) => {
                leave(editorLink(returnTo));
            },
            openPlayer: (handoff) => {
                leave(playerLink(handoff));
            },
        }),
        [session, api, leave],
    );

    return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** The session and the things that change it; only valid under a `SessionProvider`. */
export function useSession(): SessionContextValue {
    const value = useContext(SessionContext);
    if (value === null) throw new Error('useSession must be called inside a SessionProvider');
    return value;
}
