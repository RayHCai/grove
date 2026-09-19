import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { fakeApi, navigation, signedInApi } from './doubles';
import { byText, mount, need, until, untilSettled } from './helpers';

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

        expect(heading(host)).toContain('Multiplayer');
        expect(byText(host, 'button', 'Start building')).toBeDefined();
        expect(byText(host, 'button', 'Sign in')).toBeDefined();
    });

    it('offers the editor and the games to somebody holding a session', async () => {
        const api = signedInApi();
        const host = await mount(<App api={api} navigate={navigation().navigate} />);
        await untilSettled(host);

        expect(byText(host, 'button', 'Open the editor')).toBeDefined();
        expect(byText(host, 'button', 'Your games')).toBeDefined();
        // The chrome knows who it is, which is the one thing it reads the account for.
        expect(host.textContent).toContain('Rowan');
    });

    it('crosses to the editor carrying nothing but the destination', async () => {
        const api = signedInApi();
        const tab = navigation();
        const host = await mount(<App api={api} navigate={tab.navigate} />);
        await untilSettled(host);

        need<HTMLButtonElement>(host, 'button', 'Open the editor').click();
        await until(() => tab.to.length > 0);

        const crossed = new URL(tab.to[0] ?? '');
        expect(crossed.origin).toBe(EDITOR);
        // The session is a cookie on the API origin and the editor is a subdomain of this site,
        // so it is already carrying it; nothing of it rides on the URL.
        expect(crossed.search).toBe('');
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
    it('sends somebody who already holds a session to their games', async () => {
        at('/sign-in');
        const host = await mount(<App api={signedInApi()} navigate={navigation().navigate} />);
        await until(() => window.location.pathname === '/games');

        expect(heading(host)).toBe('Your games');
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
        expect(byText(host, 'button', 'Back to the front')).toBeDefined();
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

        expect(byText(host, 'button', 'Start building')).toBeDefined();
    });
});
