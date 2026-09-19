import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';

/**
 * Every root a case mounted, so the next case starts with none of them.
 *
 * A root left mounted keeps its effects: a shell from an earlier case still holds a
 * `beforeunload` listener and still believes it has unsaved work, and answers for the case
 * that came after it.
 */
const mounted: Root[] = [];

/** Unmounts everything rendered since the last call. Run from `afterEach`, never from a case. */
export function unmountAll(): void {
    for (const root of mounted.splice(0)) {
        act(() => {
            root.unmount();
        });
    }
}

/** Renders `ui` under a synchronous `act`, so a state the first effects replace is still observable. */
export function render(ui: ReactNode): { host: HTMLElement; root: Root } {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    act(() => {
        root.render(ui);
    });
    return { host, root };
}

/** Renders `ui` into a fresh host and flushes the first effects. */
export async function mount(ui: ReactNode): Promise<HTMLElement> {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    await act(async () => {
        root.render(ui);
    });
    return host;
}

/** Yields a macrotask at a time under `act` until `predicate` holds; running out of time is a failure. */
export async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start >= timeoutMs) {
            throw new Error(`the condition did not hold within ${timeoutMs}ms`);
        }
        await act(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });
    }
}

/** Resolves once nothing under `host` is `aria-busy`. */
export async function untilSettled(host: HTMLElement): Promise<void> {
    await until(() => host.querySelector('[aria-busy="true"]') === null);
}
