// Signing in and signing up: what the service is sent, where somebody lands, and what one refusal
// is allowed to say.

import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { ACCOUNT, fakeApi, navigation } from './doubles';
import { click, field, mount, need, submit, type, until, untilSettled } from './helpers';

const EDITOR = 'http://localhost:5176';
const PASSWORD = 'a-long-enough-password';

function at(path: string): void {
    window.history.replaceState(null, '', path);
}

async function signInForm(api = fakeApi(), navigate = navigation()) {
    at('/sign-in');
    const host = await mount(<App api={api} navigate={navigate.navigate} />);
    await untilSettled(host);
    return { host, api, navigate };
}

describe('signing in', () => {
    it('lands on the games page when nobody sent them here', async () => {
        const { host } = await signInForm();

        await type(field(host, 'Email'), ACCOUNT.email);
        await type(field(host, 'Password'), PASSWORD);
        await submit(need(host, 'form button', 'Sign in'));
        await until(() => window.location.pathname === '/games');

        expect(host.querySelector('h1')?.textContent?.trim()).toBe('Your games');
    });

    it('goes back to the editor when the editor sent them here', async () => {
        const api = fakeApi();
        const tab = navigation();
        at(`/sign-in?return=${encodeURIComponent(`${EDITOR}/?mode=code`)}`);
        const host = await mount(<App api={api} navigate={tab.navigate} />);
        await untilSettled(host);

        await type(field(host, 'Email'), ACCOUNT.email);
        await type(field(host, 'Password'), PASSWORD);
        await submit(need(host, 'form button', 'Sign in'));
        await until(() => tab.to.length > 0);

        const crossed = new URL(tab.to[0] ?? '');
        expect(crossed.origin).toBe(EDITOR);
        expect(crossed.searchParams.get('mode')).toBe('code');
    });

    /**
     * The service answers an unknown address, a wrong password and a locked account the same way,
     * and this page must not be the end that tells them apart — which of the three it was is the
     * fact an enumeration is looking for.
     */
    it('says one thing for every credential that does not open an account', async () => {
        const { host } = await signInForm();

        await type(field(host, 'Email'), 'nobody@grove.example');
        await type(field(host, 'Password'), PASSWORD);
        await submit(need(host, 'form button', 'Sign in'));
        await until(() => host.querySelector('[role="alert"]') !== null);
        const forUnknown = host.querySelector('[role="alert"]')?.textContent;

        await type(field(host, 'Email'), ACCOUNT.email);
        await type(field(host, 'Password'), 'not-the-password');
        await submit(need(host, 'form button', 'Sign in'));
        await until(() => host.querySelector('[role="alert"]')?.textContent === forUnknown);

        expect(forUnknown).toBe('That address and password do not match an account.');
        expect(window.location.pathname).toBe('/sign-in');
    });

    it('carries the way back over to the sign-up page', async () => {
        const back = `${EDITOR}/?mode=code`;
        at(`/sign-in?return=${encodeURIComponent(back)}`);
        const host = await mount(<App api={fakeApi()} navigate={navigation().navigate} />);
        await untilSettled(host);

        await click(need(host, 'a', 'Create an account'));
        await until(() => window.location.pathname === '/sign-up');

        // Without this, somebody who needed an account would sign up and never reach the editor.
        expect(new URL(window.location.href).searchParams.get('return')).toBe(back);
    });
});

describe('signing up', () => {
    it('makes the account and lands on the games page', async () => {
        at('/sign-up');
        const api = fakeApi();
        const host = await mount(<App api={api} navigate={navigation().navigate} />);
        await untilSettled(host);

        await type(field(host, 'Display name'), 'Juniper');
        await type(field(host, 'Email'), 'juniper@grove.example');
        await type(field(host, 'Password'), 'another-long-password');
        await submit(need(host, 'button', 'Create account'));
        await until(() => window.location.pathname === '/games');

        expect(api.account.displayName).toBe('Juniper');
        expect(host.textContent).toContain('Juniper');
    });

    it('goes straight to the editor when the editor sent them here', async () => {
        at(`/sign-up?return=${encodeURIComponent(`${EDITOR}/`)}`);
        const api = fakeApi();
        const tab = navigation();
        const host = await mount(<App api={api} navigate={tab.navigate} />);
        await untilSettled(host);

        await type(field(host, 'Display name'), 'Juniper');
        await type(field(host, 'Email'), 'juniper@grove.example');
        await type(field(host, 'Password'), 'another-long-password');
        await submit(need(host, 'button', 'Create account'));
        await until(() => tab.to.length > 0);

        expect(new URL(tab.to[0] ?? '').origin).toBe(EDITOR);
    });

    it('passes the service refusal through when the address is taken', async () => {
        at('/sign-up');
        const host = await mount(<App api={fakeApi()} navigate={navigation().navigate} />);
        await untilSettled(host);

        await type(field(host, 'Display name'), 'Rowan');
        await type(field(host, 'Email'), ACCOUNT.email);
        await type(field(host, 'Password'), 'another-long-password');
        await submit(need(host, 'button', 'Create account'));
        await until(() => host.querySelector('[role="alert"]') !== null);

        expect(host.querySelector('[role="alert"]')?.textContent).toContain(
            'already has an account',
        );
    });

    it('holds a short password to the floor before the service is asked', async () => {
        at('/sign-up');
        const api = fakeApi();
        const host = await mount(<App api={api} navigate={navigation().navigate} />);
        await untilSettled(host);

        await type(field(host, 'Display name'), 'Juniper');
        await type(field(host, 'Email'), 'juniper@grove.example');
        await type(field(host, 'Password'), 'short');
        await submit(need(host, 'button', 'Create account'));
        await until(() => host.querySelector('[role="alert"]') !== null);

        expect(host.querySelector('[role="alert"]')?.textContent).toContain('at least 8');
        expect(api.account.displayName).toBe(ACCOUNT.displayName);
    });
});

describe('signing out', () => {
    it('drops the session and leaves the front page standing', async () => {
        const api = fakeApi({ signedIn: true });
        const host = await mount(<App api={api} navigate={navigation().navigate} />);
        await untilSettled(host);

        await click(need(host, 'button', 'Sign out'));
        await until(() => api.signedIn === false);
        await untilSettled(host);

        expect(need(host, 'button', 'Get started')).toBeDefined();
    });
});
