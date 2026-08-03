// Entry point. Mounts React and nothing else.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// A side-effect import is how Vite is told to bundle a stylesheet; there is nothing to assign.
// oxlint-disable-next-line import/no-unassigned-import
import './styles.css';

const host = document.getElementById('root');
if (host === null) throw new Error('#root is missing from index.html');

// StrictMode double-invokes effects in development, which is a feature here: `useRenderer` must
// survive a mount/unmount/mount cycle without leaking a canvas or a GPU context, and this is what
// catches it if it ever stops doing so.
createRoot(host).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
