import { afterEach } from 'vitest';
import { unmountAll } from './helpers';

// React refuses to run `act` without it, and says so at the first render rather than at setup.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    // Before the address bar is reset: a root still mounted is still subscribed to the router, and
    // it would answer the reset below by redirecting the next case's app.
    unmountAll();
    localStorage.clear();
    sessionStorage.clear();
    // The router reads the address bar, so a path one case navigated to would be the page the next
    // one mounts on.
    window.history.replaceState(null, '', '/');
    document.body.innerHTML = '';
});
