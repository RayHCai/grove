import { useState } from 'react';
import { ErrorBoundary, ThemeProvider, apiUrl } from '@grove/ui';
import { createApi } from './api/client';
import type { Api } from './api/client';
import { Boot } from './boot/Boot';
import type { BootProps } from './boot/Boot';
import { CrashFlush } from './workspace/autosave';

export interface AppProps {
    /** The service this editor talks to; a test hands in its own rather than a URL to reach. */
    api?: Api | undefined;
    /** How the tab leaves for the platform; a test hands in its own rather than navigating. */
    navigate?: ((url: string) => void) | undefined;
    /** How a second tab is opened for a lapsed session; a test hands in its own. */
    openTab?: BootProps['openTab'];
    /** How the creator is told something they have to act on; a test hands in its own. */
    notify?: BootProps['notify'];
    /** How a local world's renderer is built; a test hands in one that needs no GPU. */
    createRenderer?: BootProps['createRenderer'];
}

export function App({
    api,
    navigate,
    openTab,
    notify,
    createRenderer,
}: AppProps = {}): React.JSX.Element {
    // Made once and kept: the client holds the CSRF token the last sign-in handed out, and a new
    // one per render would be a client that had never signed in.
    const [client] = useState(
        () =>
            api ??
            createApi({ baseUrl: apiUrl(import.meta.env.VITE_API_URL, import.meta.env.DEV) }),
    );
    const [crash] = useState<{ current: (() => void) | undefined }>(() => ({
        current: undefined,
    }));
    return (
        <ThemeProvider>
            {/* Sends what was typed before the recovery view replaces the workbench holding it. */}
            <ErrorBoundary onError={() => crash.current?.()}>
                <CrashFlush.Provider value={crash}>
                    <Boot
                        api={client}
                        navigate={navigate}
                        openTab={openTab}
                        notify={notify}
                        createRenderer={createRenderer}
                    />
                </CrashFlush.Provider>
            </ErrorBoundary>
        </ThemeProvider>
    );
}
