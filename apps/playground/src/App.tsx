// The app shell: chrome around a single <Stage/>. Deliberately thin — the harness's job is to
// exercise the renderer, so anything not needed to do that stays out.

import { Stage } from './Stage';

export function App(): React.JSX.Element {
    return (
        <main className="app">
            <header className="app__header">
                <h1>Grove renderer playground</h1>
                <p>
                    Click the stage to spawn a leaf. It enters from the left at the height you
                    clicked, tumbles across, and is destroyed once it clears the right edge.
                </p>
            </header>

            <Stage />
        </main>
    );
}
