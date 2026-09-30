// A creator's own games: what the page lists, what it offers to open, and what it does when the
// service will not answer.

import { describe, expect, it, vi } from 'vitest';
import { decodeHandoff } from '@grove/api-contract';
import { ApiError } from '../src/api/client';
import { App } from '../src/App';
import { GAME, navigation, OLDER_GAME, PLAY_SESSION, signedInApi } from './doubles';
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
    });

    it('crosses to the editor from the newest card, carrying nothing', async () => {
        const { host, tab } = await games();

        await click(need(host, 'button', 'Open in editor'));
        await until(() => tab.to.length > 0);

        expect(new URL(tab.to[0] ?? '').origin).toBe(EDITOR);
    });

    it('says so when there is nothing yet', async () => {
        const { host } = await games(signedInApi({ owned: [] }));

        expect(byText(host, 'button', 'Make your first game')).toBeDefined();
        expect(byText(host, 'button', 'Open in editor')).toBeUndefined();
    });
});

describe('deleting a game', () => {
    it('removes the card once the owner confirms', async () => {
        const { host, api } = await games();
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

        await click(host.querySelector<HTMLButtonElement>('button[aria-label="Delete game"]')!);
        await until(() => host.querySelectorAll('.gamecard').length === 1);

        expect(api.owned.some((game) => game.gameId === GAME.gameId)).toBe(false);
        confirm.mockRestore();
    });

    it('keeps the game when the owner backs out', async () => {
        const { host, api } = await games();
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

        await click(host.querySelector<HTMLButtonElement>('button[aria-label="Delete game"]')!);

        expect(host.querySelectorAll('.gamecard').length).toBe(2);
        expect(api.owned).toHaveLength(2);
        confirm.mockRestore();
    });

    it('busies only the card being deleted, and says nothing about opening', async () => {
        const { host, api } = await games();
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        vi.spyOn(api, 'deleteGame').mockReturnValue(new Promise(() => undefined));

        const [newest, older] = [...host.querySelectorAll<HTMLElement>('.gamecard')];
        await click(older!.querySelector('button[aria-label="Delete game"]')!);

        expect(
            older!.querySelector('button[aria-label="Delete game"]')?.getAttribute('aria-busy'),
        ).toBe('true');
        const open = need<HTMLButtonElement>(newest!, 'button', 'Open in editor');
        expect(open.getAttribute('aria-disabled')).toBe('false');
        confirm.mockRestore();
    });

    it('offers settings, but not yet', async () => {
        const { host } = await games();

        expect(
            host.querySelector<HTMLButtonElement>('button[aria-label="Game settings"]')?.disabled,
        ).toBe(true);
    });
});

describe('viewing a game', () => {
    it('offers a page to view only for a game that has been published', async () => {
        const published = { ...OLDER_GAME, publishedAt: '2026-09-12T09:00:00.000Z' };
        const { host } = await games(signedInApi({ owned: [GAME, published] }));

        const views = host.querySelectorAll<HTMLAnchorElement>('a[aria-label="View game page"]');
        expect(views).toHaveLength(1);
        expect(views[0]?.getAttribute('href')).toBe(`/games/${OLDER_GAME.gameId}`);
    });

    it('goes to the game page from the view link', async () => {
        const published = { ...GAME, publishedAt: '2026-09-12T09:00:00.000Z' };
        const { host } = await games(signedInApi({ owned: [published] }));

        await click(host.querySelector('a[aria-label="View game page"]')!);
        await until(() => host.querySelector('.gameinfo__title') !== null);

        expect(window.location.pathname).toBe(`/games/${GAME.gameId}`);
        expect(host.querySelector('h1')?.textContent).toBe(GAME.title);
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

        await click(host.querySelector<HTMLButtonElement>('button[aria-label="New game"]')!);
        await submit(need(host, 'button', 'Create and open the editor'));
        await until(() => api.owned.length > 0);

        expect(api.owned[0]?.title).toBe('Untitled game');
    });

    it('leaves the list alone when cancelled', async () => {
        const { host, api } = await games(signedInApi({ owned: [] }));

        await click(host.querySelector<HTMLButtonElement>('button[aria-label="New game"]')!);
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

/** The Play button on the card titled `title`. */
function playOn(host: HTMLElement, title: string): HTMLButtonElement {
    const card = [...host.querySelectorAll('.gamecard')].find((node) =>
        node.querySelector('.gamecard__title')?.textContent?.includes(title),
    );
    const button = [...(card?.querySelectorAll('button') ?? [])].find(
        (node) => node.textContent === 'Play',
    );
    if (button === undefined) throw new Error(`no Play on ${title}`);
    return button;
}

describe('playing a game', () => {
    /** Where the player origin is; a dev server's default, since a test build is one. */
    const PLAYER = 'http://localhost:5177';

    it('offers Play on every game, not only the newest', async () => {
        const { host } = await games();

        expect(
            [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Play'),
        ).toHaveLength(2);
    });

    it('sends the tab to the player origin with the join in the fragment', async () => {
        const { host, tab } = await games();

        await click(playOn(host, OLDER_GAME.title));
        await until(() => tab.to.length > 0);

        const url = new URL(tab.to[0] ?? '');
        expect(url.origin).toBe(PLAYER);
        // Never in the query or the path: a fragment is the one part a browser keeps to itself.
        expect(url.search).toBe('');
        expect(url.pathname).toBe('/');
        expect(decodeHandoff(url.hash.slice(1))).toEqual({
            gameId: OLDER_GAME.gameId,
            session: PLAY_SESSION,
        });
    });

    it('says why a game with no build cannot start, and stays put', async () => {
        const api = signedInApi();
        api.unplayable.add(GAME.gameId);
        const { host, tab } = await games(api);

        await click(playOn(host, GAME.title));
        await until(() => host.querySelector('[role="alert"]') !== null);

        expect(host.querySelector('[role="alert"]')?.textContent).toContain('no playable build');
        expect(tab.to).toEqual([]);
    });

    it('sends a lapsed session to sign in rather than to a game', async () => {
        const api = signedInApi();
        const { host, tab } = await games(api);
        api.signedIn = false;

        await click(playOn(host, GAME.title));
        await until(() => window.location.pathname === '/sign-in');
        expect(tab.to).toEqual([]);
    });
});
