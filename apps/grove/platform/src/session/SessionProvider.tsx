import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import type { ReactNode } from 'react';
import type { Account } from '@grove/api-contract';
import type { Api } from '../api/client';
import { editorLink } from '../editor/link';

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
    /** Leaves for the editor, optionally back to where it sent somebody from. */
    openEditor: (returnTo?: string | undefined) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export interface SessionProviderProps {
    api: Api;
    /** How the tab leaves for the editor; a test hands in its own rather than navigating. */
    navigate?: ((url: string) => void) | undefined;
    children: ReactNode;
}

/**
 * The session, read once on the first load and kept for every page after it.
 *
 * Two calls rather than one: `GET /v1/auth/session` is the one route that answers a cookie naming
 * nobody without it being a failure, and it also hands back the CSRF token every write here has to
 * carry — so it runs before the account is read and before any form can be submitted.
 */
export function SessionProvider({
    api,
    navigate,
    children,
}: SessionProviderProps): React.JSX.Element {
    const [session, setSession] = useState<Session>({ at: 'loading' });
    // StrictMode runs the effect below twice, and the second run would ask the service again for
    // an answer the first one already has.
    const asked = useRef(false);

    const go = useCallback(
        (url: string) => {
            (navigate ?? ((to: string) => window.location.assign(to)))(url);
        },
        [navigate],
    );

    const load = useCallback(async () => {
        if ((await api.session()) === undefined) {
            setSession({ at: 'anonymous' });
            return;
        }
        setSession({ at: 'signed-in', account: await api.me() });
    }, [api]);

    useEffect(() => {
        if (asked.current) return;
        asked.current = true;
        void load().catch(() => {
            // An API nobody can reach is a visitor who is not signed in: the pages behind the gate
            // say so, and the ones in front of it still work.
            setSession({ at: 'anonymous' });
        });
    }, [load]);

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

            // Nothing is minted and nothing crosses: the session is a cookie on the API origin,
            // and the editor is a subdomain of this same site, so it is already carrying it.
            openEditor: (returnTo) => {
                go(editorLink(returnTo));
            },
        }),
        [session, api, go],
    );

    return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** The session and the things that change it; only valid under a `SessionProvider`. */
export function useSession(): SessionContextValue {
    const value = useContext(SessionContext);
    if (value === null) throw new Error('useSession must be called inside a SessionProvider');
    return value;
}
