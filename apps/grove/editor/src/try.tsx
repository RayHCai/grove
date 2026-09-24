// A second front door, for trying the editor without `@grove/api`, Postgres or the platform up.
//
// `try.html` is the only thing that reaches this file, so it never rides along in the real app's
// bundle, and `vite build` never sees it either — the default build has one entry, `index.html`,
// and this one is served only by `vite dev`. What it mounts against is the same double the test
// suite drives the whole app with: an in-memory service, seeded with the default template, that
// answers every call without a network. Games made here live only in this tab's memory.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { fakeApi } from '../tests/doubles';
// A side-effect import is how Vite is told to bundle a stylesheet; there is nothing to assign.
// oxlint-disable-next-line import/no-unassigned-import
import '@grove/ui/styles.css';
// The app sheet follows the ui sheet: its equal-specificity overrides win only by source order.
// oxlint-disable-next-line import/no-unassigned-import
import './styles/editor.css';

const host = document.getElementById('root');
if (host === null) throw new Error('#root is missing from try.html');

createRoot(host).render(
    <StrictMode>
        <App api={fakeApi()} />
    </StrictMode>,
);
