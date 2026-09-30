import { describe, expect, it } from 'vitest';
import { Splash } from '../src/components/Splash.js';
import { mount } from '../src/testing.js';

describe('Splash', () => {
    it('is the page: a main holding the wordmark on a card, with a status line', async () => {
        const host = await mount(<Splash busy note="One moment…" className="boot" />);
        const main = host.querySelector('main');
        expect(main?.className).toBe('pg-splash boot');
        expect(main?.querySelector('.pg-wordmark')).not.toBeNull();
        expect(main?.querySelector('[aria-busy="true"]')).not.toBeNull();
        expect(host.querySelector('[role="status"]')?.textContent).toBe('One moment…');
    });

    it('reads a failure as an alert and is not busy unless told', async () => {
        const host = await mount(
            <Splash alert="That did not work.">
                <button type="button">Try again</button>
            </Splash>,
        );
        expect(host.querySelector('[role="alert"]')?.textContent).toBe('That did not work.');
        expect(host.querySelector('[aria-busy]')).toBeNull();
        expect(host.querySelector('button')?.textContent).toBe('Try again');
    });
});
