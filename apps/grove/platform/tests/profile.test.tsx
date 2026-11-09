// The profile: the name others see, the password, and the one thing the service refuses to do
// while the account still owns a game.

import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { ACCOUNT, navigation, signedInApi } from './doubles';
import { mount, until, untilSettled } from '@grove/ui/testing';
import { click, field, need, submit, type } from './helpers';

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
    it('shows the name and the address', async () => {
        const { host } = await profile();

        expect(field(host, 'Email').value).toBe(ACCOUNT.email);
        expect(field(host, 'Email').readOnly).toBe(true);
    });
});

describe('renaming', () => {
    it('saves the new name and tells the chrome about it', async () => {
        const { host, api } = await profile();

        await type(field(host, 'Display name'), 'Juniper');
        await submit(need(host, 'button', 'Save name'));
        await until(() => api.account.displayName === 'Juniper');

        expect(host.querySelector('.card__saved')?.textContent).toBe('Saved.');
    });
});

describe('a session another tab signed in to', () => {
    it('still saves, on the token a fresh read of the session hands back', async () => {
        const { host, api } = await profile();
        // A sign-in elsewhere rotates the session, so the token this tab read is stale now.
        api.signInElsewhere();

        await type(field(host, 'Display name'), 'Juniper');
        await submit(need(host, 'button', 'Save name'));
        await until(() => api.account.displayName === 'Juniper');

        expect(host.querySelector('.card__saved')?.textContent).toBe('Saved.');
        expect(api.requests.filter((request) => request === 'PATCH /v1/players/me')).toHaveLength(
            2,
        );
    });

    it('is told apart from a wrong current password, which is a field to correct', async () => {
        const { host, api } = await profile();
        api.signInElsewhere();

        await type(field(host, 'Current password'), 'not-the-password');
        await type(field(host, 'New password'), 'a-different-long-password');
        await submit(need(host, 'button', 'Change password'));
        await until(() => host.querySelector('.card__refusal') !== null);

        // Both are a 403, and only the second is the answer the form puts words to.
        expect(host.querySelector('.card__refusal')?.textContent).toBe(
            'That is not your current password.',
        );
    });
});

describe('changing the password', () => {
    it('hands this tab the new session’s token, so the next write carries it', async () => {
        const { host, api } = await profile();

        await type(field(host, 'Current password'), PASSWORD);
        await type(field(host, 'New password'), 'a-different-long-password');
        await submit(need(host, 'button', 'Change password'));
        await until(() => api.credentials.password === 'a-different-long-password');
        await type(field(host, 'Display name'), 'Juniper');
        await submit(need(host, 'button', 'Save name'));
        await until(() => api.account.displayName === 'Juniper');

        // One rename: the token the rotation minted was the one it carried, so nothing was refused.
        expect(api.requests.filter((request) => request === 'PATCH /v1/players/me')).toHaveLength(
            1,
        );
    });

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

        expect(host.querySelector('.card__refusal')?.textContent).toContain('at least 8');
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

describe('a session that lapsed while the page was open', () => {
    it('sends a rename to sign in rather than reporting it as a failure', async () => {
        const { host, api } = await profile();
        api.signedIn = false;

        await type(field(host, 'Display name'), 'Juniper');
        await submit(need(host, 'button', 'Save name'));
        await until(() => window.location.pathname === '/sign-in');
    });

    it('sends a password change to sign in the same way', async () => {
        const { host, api } = await profile();
        api.signedIn = false;

        await type(field(host, 'Current password'), PASSWORD);
        await type(field(host, 'New password'), 'a-different-long-password');
        await submit(need(host, 'button', 'Change password'));
        await until(() => window.location.pathname === '/sign-in');
    });
});
