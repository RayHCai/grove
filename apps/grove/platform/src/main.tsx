import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '@grove/ui';
import { App } from './App';
// A side-effect import is how Vite is told to bundle a stylesheet; there is nothing to assign.
import '@grove/ui/styles.css';
// The app sheet follows the ui sheet: equal-specificity overrides win only by source order.
import './styles/platform.css';

const host = document.getElementById('root');
if (host === null) throw new Error('#root is missing from index.html');

createRoot(host).render(
    <StrictMode>
        <ErrorBoundary>
            <App />
        </ErrorBoundary>
    </StrictMode>,
);
