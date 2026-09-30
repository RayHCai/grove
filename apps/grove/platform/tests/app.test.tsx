import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { fakeApi, navigation, signedInApi } from './doubles';
import { byText, click, mount, need, until, untilSettled } from './helpers';

const EDITOR = 'http://localhost:5176';

function at(path: string): void {
    window.history.replaceState(null, '', path);
}

function heading(host: HTMLElement): string {
    return host.querySelector('h1')?.textContent?.trim() ?? '';
}

describe('the front page', () => {
    it('says what Grove is to somebody with no account', async () => {
        const host = await mount(<App api={fakeApi()} navigate={navigation().navigate} />);
        await untilSettled(host);

        expect(heading(host)).toContain('Creativity unleashed');
        expect(byText(host, 'a', 'Start building')).toBeDefined();
        expect(byText(host, 'a', 'Sign in')).toBeDefined();
    });

    it('shows the home page to somebody holding a session', async () => {
        const api = signedInApi();
        const host = await mount(<App api={api} navigate={navigation().navigate} />);
        await untilSettled(host);

        expect(host.querySelector('.home')).not.toBeNull();
        expect(host.querySelectorAll('.shelf').length).toBeGreaterThan(0);
        expect(host.querySelector('a[aria-label="Home"]')).not.toBeNull();
        expect(host.querySelector('[role="search"]')).not.toBeNull();
    });
});

describe('the profile menu', () => {
    it('opens under the icon and offers the profile and signing out', async () => {
        const api = signedInApi();
        const host = await mount(<App api={api} navigate={navigation().navigate} />);
        await untilSettled(host);

        const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Account"]');
        expect(toggle?.getAttribute('aria-expanded')).toBe('false');
        await click(toggle!);

        expect(toggle?.getAttribute('aria-expanded')).toBe('true');
        expect(host.querySelector('.profilemenu__panel[data-open]')).not.toBeNull();
        expect(byText(host, '[role="menuitem"]', 'Profile')).toBeDefined();
    });

    it('walks its rows from the keyboard and hands focus back on Escape', async () => {
        const host = await mount(<App api={signedInApi()} navigate={navigation().navigate} />);
        await untilSettled(host);
        const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Account"]')!;
        await click(toggle);
        const menu = host.querySelector('[role="menu"]')!;
        const key = (name: string): Promise<void> =>
            act(async () => {
                menu.dispatchEvent(
                    new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
                );
            });

        expect(document.activeElement?.textContent).toBe('Profile');
        await key('ArrowDown');
        expect(document.activeElement?.textContent).toBe('Games');
        expect(document.activeElement?.tagName).toBe('A');
        await key('Escape');
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(toggle);
    });

    it('goes to the profile page', async () => {
        const host = await mount(<App api={signedInApi()} navigate={navigation().navigate} />);
        await untilSettled(host);

        await click(host.querySelector<HTMLButtonElement>('button[aria-label="Account"]')!);
        await click(need(host, '[role="menuitem"]', 'Profile'));
        await until(() => window.location.pathname === '/profile');
    });

    it('signs out and leaves the front page standing', async () => {
        const api = signedInApi();
        const host = await mount(<App api={api} navigate={navigation().navigate} />);
        await untilSettled(host);

        await click(host.querySelector<HTMLButtonElement>('button[aria-label="Account"]')!);
        await click(need(host, '[role="menuitem"]', 'Sign out'));
        await until(() => api.signedIn === false);
        await untilSettled(host);

        expect(need(host, 'a', 'Get started')).toBeDefined();
    });
});

describe('the gate in front of the signed-in pages', () => {
    it('sends an anonymous visitor from the games page to sign in', async () => {
        at('/games');
        const host = await mount(<App api={fakeApi()} navigate={navigation().navigate} />);
        await until(() => window.location.pathname === '/sign-in');

        expect(heading(host)).toBe('Sign in to Grove');
    });

    it('replaces the address rather than pushing it, so back does not land there again', async () => {
        at('/profile');
        const before = window.history.length;
        await mount(<App api={fakeApi()} navigate={navigation().navigate} />);
        await until(() => window.location.pathname === '/sign-in');

        expect(window.history.length).toBe(before);
    });
});

describe('the gate in front of the sign-in pages', () => {
    it('sends somebody who already holds a session home', async () => {
        at('/sign-in');
        const host = await mount(<App api={signedInApi()} navigate={navigation().navigate} />);
        await until(() => window.location.pathname === '/');

        expect(host.querySelector('.home')).not.toBeNull();
    });

    /**
     * The case the gate above must not swallow. The editor sends somebody here when IT has no
     * session, which says nothing about this origin. What they came for is a key, so they get one.
     */
    it('mints a key and goes back when it was the editor that sent them', async () => {
        at(`/sign-in?return=${encodeURIComponent(`${EDITOR}/?mode=code`)}`);
        const api = signedInApi();
        const tab = navigation();
        const host = await mount(<App api={api} navigate={tab.navigate} />);
        await until(() => tab.to.length > 0);

        expect(host.textContent).toContain('Taking you back to the editor');
        const crossed = new URL(tab.to[0] ?? '');
        expect(crossed.searchParams.get('mode')).toBe('code');
        // Never the sign-in form: there is nothing here to sign in to.
        expect(host.querySelector('input[type="password"]')).toBeNull();
    });

    it('sends the tab once, not once per render', async () => {
        at(`/sign-in?return=${encodeURIComponent(`${EDITOR}/`)}`);
        const api = signedInApi();
        const tab = navigation();
        await mount(<App api={api} navigate={tab.navigate} />);
        await until(() => tab.to.length > 0);

        expect(tab.to).toHaveLength(1);
    });
});

describe('an address with no page behind it', () => {
    it('says so and names the path rather than guessing one', async () => {
        at('/nowhere');
        const host = await mount(<App api={fakeApi()} navigate={navigation().navigate} />);
        await untilSettled(host);

        expect(host.textContent).toContain('/nowhere');
        expect(byText(host, 'a', 'Back to the front')).toBeDefined();
    });
});

describe('an API nobody can reach', () => {
    it('leaves the front page standing rather than a broken shell', async () => {
        const api = fakeApi({
            session: async () => {
                throw new Error('down');
            },
        });
        const host = await mount(<App api={api} navigate={navigation().navigate} />);
        await untilSettled(host);

        expect(byText(host, 'a', 'Start building')).toBeDefined();
    });
});

describe('moving between pages in place', () => {
    it('names the page in the tab and puts focus on its heading', async () => {
        at('/games');
        const host = await mount(<App api={signedInApi()} navigate={navigation().navigate} />);
        await untilSettled(host);
        expect(document.title).toBe('Your games · Grove');

        await click(need(host, '[role="menuitem"]', 'Profile'));
        await until(() => document.title === 'Your profile · Grove');

        // Nothing loads on a navigation in place, so without this nothing is announced either.
        expect(document.activeElement).toBe(host.querySelector('main h1'));
        expect(document.activeElement?.textContent).toBe('Your profile');
    });
});
