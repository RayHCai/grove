// The app shell: chrome around a single <Stage/>. Deliberately thin — the harness's job is to
// exercise the renderer, so anything not needed to do that stays out.

import { Stage } from './Stage';

export function App(): React.JSX.Element {
    return (
        <main className="app">
            <header className="app__header">
                <h1>Grove renderer playground</h1>
                <p>
                    Click the stage to spawn a leaf. Each is a real <code>@platform/core</code>{' '}
                    entity, driven by a fixed-step game loop: it enters from the left at the height
                    you clicked, tumbles across, and is destroyed once it clears the right edge. The
                    game-loop panel shows the sim; the render tree shows what it draws.
                </p>
            </header>

            <Stage />
        </main>
    );
}
