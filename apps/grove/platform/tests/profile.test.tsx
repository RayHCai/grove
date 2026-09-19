// The profile: the name others see, the password, and the one thing the service refuses to do
// while the account still owns a game.

import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { ACCOUNT, navigation, signedInApi } from './doubles';
import { click, field, mount, need, submit, type, until, untilSettled } from './helpers';

const PASSWORD = 'a-long-enough-password';

function at(path: string): void {
    window.history.replaceState(null, '', path);
}

async function profile(api = signedInApi(), tab = navigation()) {
    at('/profile');
    const host = await mount(<App api={api} navigate={tab.navigate} />);
    await untilSettled(host);
    return { host, api, tab };
}

describe('the profile page', () => {
    it('shows the name, the address and when the account started', async () => {
        const { host } = await profile();

        expect(field(host, 'Email').value).toBe(ACCOUNT.email);
        expect(field(host, 'Email').readOnly).toBe(true);
        expect(host.textContent).toContain('With Grove since');
    });
});

describe('renaming', () => {
    it('saves the new name and tells the chrome about it', async () => {
        const { host, api } = await profile();

        await type(field(host, 'Display name'), 'Juniper');
        await submit(need(host, 'button', 'Save name'));
        await until(() => api.account.displayName === 'Juniper');

        expect(host.querySelector('.card__saved')?.textContent).toBe('Saved.');
        // The header reads the held account, so a stale one there is a name the site disagrees with.
        expect(host.querySelector('.siteheader__who')?.textContent).toBe('Juniper');
    });
});

describe('changing the password', () => {
    it('changes it when the current one is right', async () => {
        const { host, api } = await profile();

        await type(field(host, 'Current password'), PASSWORD);
        await type(field(host, 'New password'), 'a-different-long-password');
        await submit(need(host, 'button', 'Change password'));
        await until(() => api.credentials.password === 'a-different-long-password');

        expect(host.textContent).toContain('Your password is changed');
    });

    it('says which field was wrong when the current one is not', async () => {
        const { host, api } = await profile();

        await type(field(host, 'Current password'), 'not-the-password');
        await type(field(host, 'New password'), 'a-different-long-password');
        await submit(need(host, 'button', 'Change password'));
        await until(() => host.querySelector('.card__refusal') !== null);

        expect(host.querySelector('.card__refusal')?.textContent).toBe(
            'That is not your current password.',
        );
        expect(api.credentials.password).toBe(PASSWORD);
    });

    it('holds a short new password to the floor before the service is asked', async () => {
        const { host, api } = await profile();

        await type(field(host, 'Current password'), PASSWORD);
        await type(field(host, 'New password'), 'short');
        await submit(need(host, 'button', 'Change password'));
        await until(() => host.querySelector('.card__refusal') !== null);

        expect(host.querySelector('.card__refusal')?.textContent).toContain('at least 12');
        expect(api.credentials.password).toBe(PASSWORD);
    });
});

describe('closing the account', () => {
    it('asks for the password before it will, rather than on a single click', async () => {
        const { host } = await profile();

        await click(need(host, 'button', 'Close my account'));
        expect(field(host, 'Your password')).toBeDefined();
        expect(need(host, 'button', 'Keep my account')).toBeDefined();
    });

    /** The games, their bundles and their leaderboard rows live where no cascade here reaches. */
    it('passes on the service refusal while a game is still owned', async () => {
        const { host, api } = await profile();

        await click(need(host, 'button', 'Close my account'));
        await type(field(host, 'Your password'), PASSWORD);
        await submit(need(host, 'button', 'Close it for good'));
        await until(() => host.querySelector('.card__refusal') !== null);

        expect(host.querySelector('.card__refusal')?.textContent).toContain('delete your games');
        expect(api.signedIn).toBe(true);
    });

    it('closes it and leaves for the front page when nothing is owned', async () => {
        const { host, api } = await profile(signedInApi({ owned: [] }));

        await click(need(host, 'button', 'Close my account'));
        await type(field(host, 'Your password'), PASSWORD);
        await submit(need(host, 'button', 'Close it for good'));
        await until(() => window.location.pathname === '/');

        expect(api.signedIn).toBe(false);
    });
});
