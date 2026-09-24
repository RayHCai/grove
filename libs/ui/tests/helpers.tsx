import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';

/** Renders `ui` into a fresh host and flushes the first effects; the root is for the cases that unmount. */
export async function mountRoot(ui: ReactNode): Promise<{ host: HTMLElement; root: Root }> {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
        root.render(ui);
    });
    return { host, root };
}

/** `mountRoot` for the common case that only reads the host. */
export async function mount(ui: ReactNode): Promise<HTMLElement> {
    return (await mountRoot(ui)).host;
}
