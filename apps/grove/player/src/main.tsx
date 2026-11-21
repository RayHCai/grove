import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary, installErrorReporting, platformUrl } from '@grove/ui';
import { App } from './App';
import { serverPolicy } from './servers';
import '@grove/ui/styles.css';
// The app sheet follows the ui sheet: equal-specificity overrides win only by source order.
import './styles.css';

installErrorReporting({ beaconUrl: import.meta.env.VITE_ERROR_BEACON_URL });

const host = document.getElementById('root');
if (host === null) throw new Error('#root is missing from index.html');

const platform = platformUrl(import.meta.env.VITE_PLATFORM_URL, import.meta.env.DEV);
const servers = serverPolicy(import.meta.env.VITE_GAME_HOSTS, import.meta.env.DEV);

createRoot(host).render(
    <StrictMode>
        <ErrorBoundary>
            <App platformUrl={platform} servers={servers} />
        </ErrorBoundary>
    </StrictMode>,
);
