import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import { App } from '../src/App';
import { draftFromText } from '../src/workspace/files';
import { fakeApi, GAME, stored } from './doubles';
import type { FakeApi } from './doubles';
import { mount, until, untilSettled } from './helpers';

function workbench(host: HTMLElement): HTMLElement | null {
    return host.querySelector<HTMLElement>('main.workspace');
}

async function openEditor(api: FakeApi): Promise<HTMLElement> {
    const host = await mount(<App api={api} />);
    await until(() => workbench(host) !== null);
    await untilSettled(host);
    return host;
}

describe('the first load', () => {
    it('reports where it has got to before there is a workbench to show', async () => {
        // A service that never answers is what holds the screen still long enough to read it.
        const never = new Promise<never>(() => undefined);
        const host = await mount(<App api={fakeApi({ session: async () => never })} />);

        const bar = host.querySelector('[role="progressbar"]');
        expect(host.querySelector('.pg-progress__label')?.textContent).toBe(
            'Checking your session',
        );
        expect(bar?.getAttribute('aria-valuenow')).toBe('1');
        expect(bar?.getAttribute('aria-valuemax')).toBe('4');
    });

    it('moves the loading screen along one step per question it answers', async () => {
        const never = new Promise<never>(() => undefined);
        const host = await mount(<App api={fakeApi({ me: async () => never })} />);
        await until(
            () => host.querySelector('.pg-progress__label')?.textContent === 'Reading your account',
        );
        expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('2');
    });

    it('opens the workbench on the creator’s game, with every landmark under a theme', async () => {
        const host = await openEditor(fakeApi());

        expect(host.querySelector('header')).not.toBeNull();
        expect(host.querySelector('nav')?.getAttribute('aria-label')).toBe('Editor');
        const asides = [...host.querySelectorAll('aside')].map((a) => a.getAttribute('aria-label'));
        expect(asides).toEqual(['Explorer', 'Grove AI']);
        expect(workbench(host)?.querySelector('[role="tabpanel"]')?.id).toBe('editor-tabpanel');
        expect(host.querySelector('#editor-title')?.textContent).toBe('Editor');
        expect(host.querySelector('#play-title')?.textContent).toBe('Play');
        expect(host.querySelector('#console-title')?.textContent).toBe('Console');
        expect(document.documentElement.dataset.theme).toBe('light');
        expect(host.querySelector('.topbar__title')?.textContent).toBe("Pip's Garden");
    });

    it('seeds the template into a game nothing has ever saved, and leaves it unsaved', async () => {
        const api = fakeApi();
        const host = await openEditor(api);

        const names = [...host.querySelectorAll('.tree__name')].map((name) => name.textContent);
        expect(names).toContain('main.ts');
        expect(host.querySelector('.topbar__state')?.textContent).toBe('Unsaved changes');
        // Opening an editor writes nothing: the first save is the creator's.
        expect(api.saves).toEqual([]);
        expect(api.bucket.size).toBe(0);
    });

    it('reads a saved game back out of the bucket rather than seeding over it', async () => {
        const api = fakeApi();
        await stored(api, [draftFromText('src/main.ts', 'console.log("saved");')]);
        const host = await openEditor(api);

        const names = [...host.querySelectorAll('.tree__name')].map((name) => name.textContent);
        expect(names).toEqual(['src', 'main.ts']);
        expect(host.querySelector('.topbar__state')?.textContent).toBe('Up to date');
    });

    it('makes a game for a creator who has none', async () => {
        const api = fakeApi({ owned: [] });
        await openEditor(api);
        expect(api.owned).toEqual([{ ...GAME, title: 'Untitled game' }]);
    });

    it('offers a way back when the service cannot be reached at all', async () => {
        let reachable = false;
        const api = fakeApi({
            session: async () => {
                if (!reachable)
                    throw new ApiError(0, 'unreachable', 'the Grove API could not be reached');
                return { playerId: GAME.ownerId, csrfToken: 'a-token' };
            },
        });
        const host = await mount(<App api={api} />);
        await until(() => host.querySelector('[role="alert"]') !== null);
        expect(host.querySelector('[role="alert"]')?.textContent).toBe(
            'the Grove API could not be reached',
        );

        reachable = true;
        await act(async () => {
            [...host.querySelectorAll('button')]
                .find((each) => each.textContent === 'Try again')
                ?.click();
        });
        await until(() => workbench(host) !== null);
        expect(workbench(host)).not.toBeNull();
    });
});

function openedWith(api: FakeApi, went: string[]): Promise<HTMLElement> {
    return mount(<App api={api} navigate={(url) => went.push(url)} />);
}

describe('reading the session off the cookie', () => {
    it('opens on the cookie the platform already set, with nothing in the address bar', async () => {
        const went: string[] = [];
        const host = await openedWith(fakeApi({ signedIn: true }), went);
        await until(() => workbench(host) !== null);

        expect(went).toEqual([]);
        expect(window.location.search).toBe('');
        expect(host.querySelector('.topbar__title')?.textContent).toBe("Pip's Garden");
    });

    it('asks the service who this is rather than reading anything itself', async () => {
        // The cookie is HttpOnly and belongs to the API origin; the one read is the round trip.
        const asked: string[] = [];
        const api = fakeApi({ signedIn: true });
        const watched = {
            ...api,
            session: async () => {
                asked.push('session');
                return api.session();
            },
        };
        const host = await openedWith(watched as FakeApi, []);
        await until(() => workbench(host) !== null);
        expect(asked).toEqual(['session']);
    });

    it('sends a visitor the service does not recognise to the platform to sign in', async () => {
        const went: string[] = [];
        const host = await openedWith(fakeApi({ signedIn: false }), went);
        await until(() => went.length > 0);

        expect(workbench(host)).toBeNull();
        expect(host.querySelector('[role="status"]')?.textContent).toBe(
            'Taking you to Grove to sign in…',
        );
        expect(went[0]).toContain('/sign-in?return=');
    });

    it('carries a way back that is this editor, so signing in lands where it started', async () => {
        const went: string[] = [];
        await openedWith(fakeApi({ signedIn: false }), went);
        await until(() => went.length > 0);

        const back = new URL(String(new URL(went[0] ?? '').searchParams.get('return')));
        expect(back.origin).toBe(window.location.origin);
        // Nothing of the session rides on it: the cookie is what the browser brings back.
        expect(back.search).toBe('');
    });

    it('leaves for the platform when a session lapses between the check and the first read', async () => {
        const went: string[] = [];
        const api = fakeApi({ signedIn: true });
        const lapsing = {
            ...api,
            me: async () => {
                throw new ApiError(401, 'unauthorized', 'sign in first');
            },
        };
        await openedWith(lapsing as FakeApi, went);
        await until(() => went.length > 0);
        expect(went[0]).toContain('/sign-in?return=');
    });

    it('says so rather than bouncing off the platform a second time', async () => {
        const went: string[] = [];
        await openedWith(fakeApi({ signedIn: false }), went);
        await until(() => went.length > 0);

        // The platform sent this tab straight back, still holding nothing.
        const again = await openedWith(fakeApi({ signedIn: false }), went);
        await until(() => again.querySelector('[role="alert"]') !== null);

        expect(went).toHaveLength(1);
        expect(again.querySelector('[role="alert"]')?.textContent).toContain(
            'signing in did not take',
        );
    });

    it('forgets it was ever sent away once the cookie answers', async () => {
        const went: string[] = [];
        await openedWith(fakeApi({ signedIn: false }), went);
        await until(() => went.length > 0);

        const back = await openedWith(fakeApi({ signedIn: true }), went);
        await until(() => workbench(back) !== null);

        // Sent away once more, it goes: the flag is spent, not stuck.
        const third: string[] = [];
        await openedWith(fakeApi({ signedIn: false }), third);
        await until(() => third.length > 0);
        expect(third).toHaveLength(1);
    });

    it('goes back to the platform when the session is ended from the top bar', async () => {
        const went: string[] = [];
        const api = fakeApi({ signedIn: true });
        const host = await openedWith(api, went);
        await until(() => workbench(host) !== null);
        await untilSettled(host);

        await act(async () => {
            [...host.querySelectorAll('button')]
                .find((each) => each.textContent === 'Sign out')
                ?.click();
        });
        await until(() => went.length > 0);

        expect(api.signedIn).toBe(false);
        expect(workbench(host)).toBeNull();
        expect(went[0]).toContain('/sign-in?return=');
    });
});
