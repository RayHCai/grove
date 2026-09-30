// One game's page: reached from a home tile or a creator's own list, what it shows from either
// source, and the way in from it.

import { describe, expect, it } from 'vitest';
import { decodeHandoff } from '@grove/api-contract';
import type { Game } from '@grove/api-contract';
import { ApiError } from '../src/api/client';
import { App } from '../src/App';
import { tileAt } from '../src/catalog/placeholder';
import { ACCOUNT, GAME, navigation, OLDER_GAME, PLAY_SESSION, signedInApi } from './doubles';
import { byText, click, mount, need, until, untilSettled } from './helpers';

const PLAYER = 'http://localhost:5177';

const PUBLISHED: Game = { ...GAME, visibility: 'public', publishedAt: '2026-09-12T09:00:00.000Z' };

function at(path: string): void {
    window.history.replaceState(null, '', path);
}

async function page(path: string, api = signedInApi({ owned: [PUBLISHED, OLDER_GAME] })) {
    at(path);
    const tab = navigation();
    const host = await mount(<App api={api} navigate={tab.navigate} />);
    await untilSettled(host);
    return { host, api, tab };
}

function stat(host: HTMLElement, term: string): string | undefined {
    const item = [...host.querySelectorAll('.gamestats__item')].find(
        (node) => node.querySelector('dt')?.textContent === term,
    );
    return item?.querySelector('dd')?.textContent ?? undefined;
}

function playButton(host: HTMLElement): HTMLButtonElement {
    const found = host.querySelector<HTMLButtonElement>('.gameinfo__play');
    if (found === null) throw new Error('no Play button');
    return found;
}

describe('reaching a game page', () => {
    it('opens from a tile on the home page, as the game that tile showed', async () => {
        const { host } = await page('/');
        const tile = host.querySelector<HTMLAnchorElement>('.tile__link');
        const title = tile?.querySelector('.tile__title')?.textContent;

        await click(tile!);
        await until(() => host.querySelector('.gamepage') !== null);

        expect(window.location.pathname).toBe('/games/game-0');
        expect(host.querySelector('h1')?.textContent).toBe(title);
    });

    it('sends somebody with no session to sign in first', async () => {
        await page('/games/game-3', signedInApi({ signedIn: false }));
        await until(() => window.location.pathname === '/sign-in');
    });

    it('names the game in the tab', async () => {
        await page('/games/game-3');
        expect(document.title).toBe(`${tileAt(3).title} · Grove`);
    });
});

describe('a sample game', () => {
    it('shows the tile it came from, with its creator and its counts', async () => {
        const { host } = await page('/games/game-5');
        const tile = tileAt(5);

        expect(host.querySelector('h1')?.textContent).toBe(tile.title);
        expect(host.querySelector('.gameinfo__creator')?.textContent).toBe(tile.creator);
        expect(stat(host, 'Visibility')).toBe('public');
        expect(host.querySelector('[role="progressbar"]')).not.toBeNull();
    });

    it('offers no way in, and says why', async () => {
        const { host, tab } = await page('/games/game-5');

        expect(playButton(host).getAttribute('aria-disabled')).toBe('true');
        expect(host.textContent).toContain('A sample game: there is nothing to join yet.');
        await click(playButton(host));
        expect(tab.to).toEqual([]);
    });

    it('lists its servers under the Servers tab', async () => {
        const { host } = await page('/games/game-5');

        await click(need(host, '[role="tab"]', 'Servers'));

        expect(need(host, '[role="tab"]', 'Servers').getAttribute('aria-selected')).toBe('true');
        expect(host.querySelectorAll('.server').length).toBeGreaterThan(0);
        expect(byText(host, 'button', 'Join')?.getAttribute('aria-disabled')).toBe('true');
    });

    it('suggests other games, never itself', async () => {
        const { host } = await page('/games/game-5');

        const suggested = [...host.querySelectorAll<HTMLAnchorElement>('.tile__link')].map((link) =>
            link.getAttribute('href'),
        );
        expect(suggested.length).toBeGreaterThan(0);
        expect(suggested).not.toContain('/games/game-5');
    });

    it('starts the next game fresh when a suggestion is followed', async () => {
        const { host } = await page('/games/game-5');
        await click(need(host, '[role="tab"]', 'Servers'));

        const next = host.querySelector<HTMLAnchorElement>('.tile__link')!;
        const title = next.querySelector('.tile__title')?.textContent;
        await click(next);

        expect(host.querySelector('h1')?.textContent).toBe(title);
        expect(need(host, '[role="tab"]', 'About').getAttribute('aria-selected')).toBe('true');
    });
});

describe("one of the viewer's own games", () => {
    it('shows what the service holds and nothing it does not', async () => {
        const { host } = await page(`/games/${GAME.gameId}`);

        expect(host.querySelector('h1')?.textContent).toBe(GAME.title);
        expect(host.querySelector('.gameinfo__creator')?.textContent).toBe(ACCOUNT.displayName);
        expect(byText(host, '.pg-badge', 'Yours')).toBeDefined();
        // Nobody counts a real game's visits yet, and zero would be a claim about them.
        expect(stat(host, 'Visits')).toBe('—');
        expect(host.textContent).toContain('No ratings yet.');
        expect(host.textContent).toContain(
            `${ACCOUNT.displayName} has not written a description yet.`,
        );
    });

    it('says a game was never published rather than inventing an update', async () => {
        const { host } = await page(`/games/${OLDER_GAME.gameId}`);

        expect(stat(host, 'Updated')).toBe('Never published');
        expect(byText(host, '.pg-tag', 'Not published')).toBeDefined();
    });

    it('sends the tab to the player origin from Play', async () => {
        const { host, tab } = await page(`/games/${GAME.gameId}`);

        await click(playButton(host));
        await until(() => tab.to.length > 0);

        const url = new URL(tab.to[0] ?? '');
        expect(url.origin).toBe(PLAYER);
        expect(decodeHandoff(url.hash.slice(1))).toEqual({
            gameId: GAME.gameId,
            session: PLAY_SESSION,
        });
    });

    it('says why a game with no build cannot start, and stays put', async () => {
        const api = signedInApi({ owned: [PUBLISHED] });
        api.unplayable.add(GAME.gameId);
        const { host, tab } = await page(`/games/${GAME.gameId}`, api);

        await click(playButton(host));
        await until(() => host.querySelector('[role="alert"]') !== null);

        expect(host.querySelector('[role="alert"]')?.textContent).toContain('no playable build');
        expect(tab.to).toEqual([]);
    });
});

describe('a game the page cannot show', () => {
    it('says so for an id that is not one of the viewer’s games', async () => {
        const { host } = await page('/games/3f2a8e1c-0000-4000-8000-000000000000');

        expect(host.querySelector('h1')?.textContent).toBe('No game to show');
        expect(byText(host, 'a', 'Your games')?.getAttribute('href')).toBe('/games');
    });

    it('offers another go when the service will not answer', async () => {
        const api = signedInApi({ owned: [PUBLISHED] });
        const listing = api.games;
        let asked = 0;
        api.games = async () => {
            asked += 1;
            if (asked === 1) throw new ApiError(500, 'internal', 'nope');
            return listing();
        };
        const { host } = await page(`/games/${GAME.gameId}`, api);
        expect(host.textContent).toContain('This game could not be looked up');

        await click(need(host, 'button', 'Try again'));
        await until(() => host.querySelector('.gameinfo__title') !== null);
        expect(host.querySelector('h1')?.textContent).toBe(GAME.title);
    });

    it('sends a lapsed session to sign in', async () => {
        const api = signedInApi();
        api.games = async () => {
            throw new ApiError(401, 'unauthorized', 'sign in first');
        };

        await page(`/games/${GAME.gameId}`, api);
        await until(() => window.location.pathname === '/sign-in');
    });
});
