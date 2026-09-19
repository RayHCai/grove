import { webcrypto } from 'node:crypto';
import { afterEach, vi } from 'vitest';

// React refuses to run `act` without it, and says so at the first render rather than at setup.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no Worker, ResizeObserver or document.fonts, so the real Monaco boundary cannot load.
vi.mock('../src/editor/monaco', () => ({
    mountEditor: vi.fn(() => ({
        dispose: vi.fn(),
        setTheme: vi.fn(),
        syncFiles: vi.fn(),
        openFile: vi.fn(),
        getValue: () => '',
        onChange: vi.fn(),
        emit: vi.fn(async () => ({ modules: {}, problems: [] })),
    })),
}));

// jsdom's crypto has no subtle, and naming a file is hashing its bytes.
if (globalThis.crypto.subtle === undefined) {
    Object.defineProperty(globalThis.crypto, 'subtle', { value: webcrypto.subtle });
}

afterEach(async () => {
    // Before the DOM is cleared: a root whose host is already gone still runs its cleanup, and a
    // shell left mounted keeps the window listeners it registered.
    (await import('./helpers')).unmountAll();
    localStorage.clear();
    sessionStorage.clear();
    // A query left in the address bar would be read by whatever mounts next.
    window.history.replaceState(null, '', '/');
    document.documentElement.removeAttribute('data-theme');
    document.body.innerHTML = '';
});
