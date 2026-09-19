// The forgotten-password path: the answer that tells nobody which addresses are registered, and
// what happens to the key the mail linked with.

import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { ACCOUNT, fakeApi, navigation } from './doubles';
import { field, mount, need, submit, type, until, untilSettled } from './helpers';

function at(path: string): void {
    window.history.replaceState(null, '', path);
}

async function page(path: string, api = fakeApi()) {
    at(path);
    const host = await mount(<App api={api} navigate={navigation().navigate} />);
    await untilSettled(host);
    return { host, api };
}

describe('asking for a reset link', () => {
    /**
     * The route is unauthenticated and answers 202 either way, so this page must not be the end
     * that distinguishes them — which addresses have accounts is not its to tell.
     */
    it('says the same thing whether or not the address has an account', async () => {
        const known = await page('/forgot-password');
        await type(field(known.host, 'Email'), ACCOUNT.email);
        await submit(need(known.host, 'button', 'Send the link'));
        await until(() => known.host.querySelector('[role="status"]') !== null);
        const forKnown = known.host.querySelector('[role="status"]')?.textContent;

        const unknown = await page('/forgot-password');
        await type(field(unknown.host, 'Email'), 'nobody@grove.example');
        await submit(need(unknown.host, 'button', 'Send the link'));
        await until(() => unknown.host.querySelector('[role="status"]') !== null);
        const forUnknown = unknown.host.querySelector('[role="status"]')?.textContent;

        expect(forKnown?.replace(ACCOUNT.email, 'ADDRESS')).toBe(
            forUnknown?.replace('nobody@grove.example', 'ADDRESS'),
        );
    });

    it('sends the address the service was given', async () => {
        const { host, api } = await page('/forgot-password');

        await type(field(host, 'Email'), ACCOUNT.email);
        await submit(need(host, 'button', 'Send the link'));
        await until(() => api.resetsAsked.length > 0);

        expect(api.resetsAsked).toEqual([ACCOUNT.email]);
    });
});

describe('spending the key from the mail', () => {
    /**
     * Read once and taken straight off the address bar: a URL reaches the history, a bookmark and
     * the `Referer` of every request this page goes on to make, and this one opens an account until
     * it is spent.
     */
    it('takes the key out of the address bar and still spends it', async () => {
        const api = fakeApi();
        api.resetKeys.add('a-reset-key');
        const { host } = await page('/reset-password?token=a-reset-key', api);

        await until(() => new URL(window.location.href).searchParams.get('token') === null);
        expect(window.location.pathname).toBe('/reset-password');

        await type(field(host, 'New password'), 'a-brand-new-password');
        await submit(need(host, 'button', 'Set the password'));
        await until(() => host.textContent?.includes('Your new password is set') === true);

        expect(api.credentials.password).toBe('a-brand-new-password');
        expect(api.resetKeys.has('a-reset-key')).toBe(false);
    });

    it('says one thing for a key that is wrong, spent or expired', async () => {
        const { host } = await page('/reset-password?token=never-minted');

        await type(field(host, 'New password'), 'a-brand-new-password');
        await submit(need(host, 'button', 'Set the password'));
        await until(() => host.querySelector('[role="alert"]') !== null);

        expect(host.querySelector('[role="alert"]')?.textContent).toContain('no longer good');
    });

    it('points at the mail when the link carried no key at all', async () => {
        const { host } = await page('/reset-password');

        expect(host.textContent).toContain('missing its key');
        expect(need(host, 'a', 'Ask for a new link')).toBeDefined();
    });

    /** Spending a key signs nobody in and ends every session the account was holding. */
    it('sends them to sign in rather than pretending they are', async () => {
        const api = fakeApi();
        api.resetKeys.add('a-reset-key');
        const { host } = await page('/reset-password?token=a-reset-key', api);

        await type(field(host, 'New password'), 'a-brand-new-password');
        await submit(need(host, 'button', 'Set the password'));
        await until(() => host.textContent?.includes('Your new password is set') === true);

        expect(host.textContent).toContain('has been signed out');
        expect(need(host, 'a', 'Sign in')).toBeDefined();
    });
});
