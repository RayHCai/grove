// The app shell: chrome around a single <Stage/>. Deliberately thin — the harness's job is to
// exercise the renderer, so anything not needed to do that stays out.

import { Stage } from './Stage';

export function App(): React.JSX.Element {
    return (
        <main className="app">
            <Stage />
        </main>
    );
}
