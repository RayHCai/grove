import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// oxlint-disable-next-line import/no-unassigned-import
import '@grove/ui/styles.css';
// The app sheet follows the ui sheet: equal-specificity overrides win only by source order.
// oxlint-disable-next-line import/no-unassigned-import
import './styles.css';

/** Where a refused join goes back to. The one thing this origin is configured with. */
function platformUrl(): string {
    const named: unknown = import.meta.env['VITE_PLATFORM_URL'];
    return typeof named === 'string' && named !== '' ? named : 'http://localhost:5175';
}

const host = document.getElementById('root');
if (host === null) throw new Error('#root is missing from index.html');

createRoot(host).render(
    <StrictMode>
        <App platformUrl={platformUrl()} />
    </StrictMode>,
);
