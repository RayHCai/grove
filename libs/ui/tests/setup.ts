import { afterEach } from 'vitest';
import { unmountAll } from '../src/testing.js';

// React refuses to run `act` without it, and says so at the first render rather than at setup.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    // Before the DOM is cleared: a root whose host is already gone still runs its cleanup.
    unmountAll();
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.body.innerHTML = '';
});
