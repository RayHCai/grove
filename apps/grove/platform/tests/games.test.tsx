// A creator's own games: what the page lists, what it offers to open, and what it does when the
// service will not answer.

import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import { App } from '../src/App';
import { GAME, navigation, OLDER_GAME, signedInApi } from './doubles';
import { byText, click, field, mount, need, submit, type, until, untilSettled } from './helpers';

/** Where the editor is; the crossing goes to its origin and carries nothing else. */
const EDITOR = 'http://localhost:5176';

function at(path: string): void {
    window.history.replaceState(null, '', path);
}

async function games(api = signedInApi(), tab = navigation()) {
    at('/games');
    const host = await mount(<App api={api} navigate={tab.navigate} />);
    await untilSettled(host);
    return { host, api, tab };
}

describe('the games page', () => {
    it('lists what the creator owns, newest first', async () => {
        const { host } = await games();

        const titles = [...host.querySelectorAll('.gamecard__title')].map((node) =>
            node.textContent?.trim(),
        );
        expect(titles).toEqual([GAME.title, OLDER_GAME.title]);
    });

    /**
     * The editor opens the newest game and has no way to be pointed at another, so only the first
     * card offers to open one. A button on the rest would name that game and open a different one.
     */
    it('offers to open only the game the editor would actually open', async () => {
        const { host } = await games();

        expect(host.querySelectorAll('.gamecard').length).toBe(2);
        expect(
            [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Open in editor'),
        ).toHaveLength(1);
        expect(host.textContent).toContain(`The editor opens your newest game, ${GAME.title}`);
    });

    it('crosses to the editor from the newest card, carrying nothing', async () => {
        const { host, tab } = await games();

        await click(need(host, 'button', 'Open in editor'));
        await until(() => tab.to.length > 0);

        expect(new URL(tab.to[0] ?? '').origin).toBe(EDITOR);
    });

    it('says so when there is nothing yet', async () => {
        const { host } = await games(signedInApi({ owned: [] }));

        expect(host.textContent).toContain('Nothing here yet');
        expect(byText(host, 'button', 'Make your first game')).toBeDefined();
        expect(byText(host, 'button', 'Open in editor')).toBeUndefined();
    });
});

describe('making a game', () => {
    it('names it, makes it, and opens the editor on it', async () => {
        const { host, api, tab } = await games(signedInApi({ owned: [] }));

        await click(need(host, 'button', 'Make your first game'));
        await type(field(host, 'Game title'), 'Lantern Run');
        await submit(need(host, 'button', 'Create and open the editor'));
        await until(() => tab.to.length > 0);

        expect(api.owned[0]?.title).toBe('Lantern Run');
        // Made before the crossing, in that order: the new game is what makes it the newest, which
        // is the one the editor opens on.
        expect(new URL(tab.to[0] ?? '').origin).toBe(EDITOR);
    });

    it('takes an untitled one rather than refusing an empty field', async () => {
        const { host, api } = await games(signedInApi({ owned: [] }));

        await click(need(host, 'button', 'New game'));
        await submit(need(host, 'button', 'Create and open the editor'));
        await until(() => api.owned.length > 0);

        expect(api.owned[0]?.title).toBe('Untitled game');
    });

    it('leaves the list alone when cancelled', async () => {
        const { host, api } = await games(signedInApi({ owned: [] }));

        await click(need(host, 'button', 'New game'));
        await click(need(host, 'button', 'Cancel'));

        expect(api.owned).toHaveLength(0);
        expect(byText(host, 'button', 'Create and open the editor')).toBeUndefined();
    });
});

describe('when the service will not answer', () => {
    it('offers another go rather than an empty page', async () => {
        let asked = 0;
        const api = signedInApi();
        const listing = api.games;
        api.games = async () => {
            asked += 1;
            if (asked === 1) throw new ApiError(500, 'internal', 'nope');
            return listing();
        };

        const { host } = await games(api);
        expect(host.textContent).toContain('Your games could not be listed');

        await click(need(host, 'button', 'Try again'));
        await until(() => host.querySelector('.gamecard') !== null);
        expect(host.textContent).toContain(GAME.title);
    });

    /** A session that lapsed between the gate and this read is the sign-in page, not an error. */
    it('sends a lapsed session to sign in', async () => {
        const api = signedInApi();
        api.games = async () => {
            throw new ApiError(401, 'unauthorized', 'sign in first');
        };

        await games(api);
        await until(() => window.location.pathname === '/sign-in');
    });
});
