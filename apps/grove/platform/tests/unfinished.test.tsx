// A build that was not told to show what is drawn but not wired to anything yet.

import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { navigation, signedInApi } from './doubles';
import { mount, untilSettled } from './helpers';

vi.mock('../src/unfinished', () => ({ UNFINISHED: false }));

function at(path: string): void {
    window.history.replaceState(null, '', path);
}

describe('a build without the unfinished parts', () => {
    it('greets somebody holding a session with the front door, not made-up games', async () => {
        const host = await mount(<App api={signedInApi()} navigate={navigation().navigate} />);
        await untilSettled(host);

        expect(host.querySelector('.home')).toBeNull();
        expect(host.querySelector('.landing')).not.toBeNull();
        expect(host.querySelector('[role="search"]')).toBeNull();
    });

    it('offers no game settings it cannot open', async () => {
        at('/games');
        const host = await mount(<App api={signedInApi()} navigate={navigation().navigate} />);
        await untilSettled(host);

        expect(host.querySelectorAll('.gamecard').length).toBeGreaterThan(0);
        expect(host.querySelector('button[aria-label="Game settings"]')).toBeNull();
    });
});
