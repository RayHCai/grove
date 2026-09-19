import { useState } from 'react';
import { ThemeProvider } from '@grove/ui';
import { apiBaseUrl, createApi } from './api/client';
import type { Api } from './api/client';
import { Boot } from './boot/Boot';

export interface AppProps {
    /** The service this editor talks to; a test hands in its own rather than a URL to reach. */
    api?: Api | undefined;
    /** How the tab leaves for the platform; a test hands in its own rather than navigating. */
    navigate?: ((url: string) => void) | undefined;
}

export function App({ api, navigate }: AppProps = {}): React.JSX.Element {
    // Made once and kept: the client holds the CSRF token the last sign-in handed out, and a new
    // one per render would be a client that had never signed in.
    const [client] = useState(() => api ?? createApi({ baseUrl: apiBaseUrl() }));
    return (
        <ThemeProvider>
            <Boot api={client} navigate={navigate} />
        </ThemeProvider>
    );
}
