import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';

// A root left mounted keeps its effects and listeners, and answers for whichever case runs next.
const mounted: Root[] = [];

/** Renders `ui` into a fresh host under a synchronous `act`, so a state the first effects replace is still observable. */
export function render(ui: ReactNode): { host: HTMLElement; root: Root } {
    const { host, root } = attach();
    act(() => {
        root.render(ui);
    });
    return { host, root };
}

/** Renders `ui` into a fresh host and flushes the first effects; the root is for a case that unmounts it itself. */
export async function mountRoot(ui: ReactNode): Promise<{ host: HTMLElement; root: Root }> {
    const { host, root } = attach();
    await act(async () => {
        root.render(ui);
    });
    return { host, root };
}

/** `mountRoot` for the common case that only reads the host. */
export async function mount(ui: ReactNode): Promise<HTMLElement> {
    return (await mountRoot(ui)).host;
}

/** Unmounts every root rendered since the last call; run it from `afterEach`, before the DOM is cleared. */
export function unmountAll(): void {
    for (const root of mounted.splice(0)) {
        act(() => {
            root.unmount();
        });
    }
}

/** Yields a macrotask at a time under `act` until `predicate` holds; running out of time is a failure. */
export async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start >= timeoutMs) {
            throw new Error(`the condition did not hold within ${String(timeoutMs)}ms`);
        }
        // Polling is one wait after another by definition: each yield is what the next check reads.
        // oxlint-disable-next-line no-await-in-loop
        await act(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });
    }
}

/** Resolves once nothing under `host` is `aria-busy`. */
export async function untilSettled(host: HTMLElement): Promise<void> {
    await until(() => host.querySelector('[aria-busy="true"]') === null);
}

function attach(): { host: HTMLElement; root: Root } {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    return { host, root };
}
