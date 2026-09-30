import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary, configuredUrl } from '@grove/ui';
import { App } from './App';
import '@grove/ui/styles.css';
// The app sheet follows the ui sheet: equal-specificity overrides win only by source order.
import './styles.css';

const host = document.getElementById('root');
if (host === null) throw new Error('#root is missing from index.html');

const platformUrl = configuredUrl(
    'VITE_PLATFORM_URL',
    import.meta.env.VITE_PLATFORM_URL,
    'http://localhost:5175',
    import.meta.env.DEV,
);

createRoot(host).render(
    <StrictMode>
        <ErrorBoundary>
            <App platformUrl={platformUrl} />
        </ErrorBoundary>
    </StrictMode>,
);
