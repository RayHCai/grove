// Where somebody with no session is sent, and the way back that rides with them.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { profileUrl, signInUrl } from '../src/boot/platform';

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('the platform’s addresses', () => {
    it('are the same whether or not the platform’s own address ends in a slash', () => {
        const here = new URL('https://editor.grove.example/?game=pip');
        for (const platform of ['https://grove.example', 'https://grove.example/']) {
            vi.stubEnv('VITE_PLATFORM_URL', platform);
            expect(signInUrl(here)).toBe(
                'https://grove.example/sign-in?return=https%3A%2F%2Feditor.grove.example%2F%3Fgame%3Dpip',
            );
            expect(profileUrl()).toBe('https://grove.example/profile');
        }
    });

    it('carry this page back whole, so the return survives being read as a query', () => {
        vi.stubEnv('VITE_PLATFORM_URL', 'https://grove.example/');
        const back = new URL(signInUrl(new URL('https://editor.grove.example/a?b=1&c=2#d')));
        expect(back.searchParams.get('return')).toBe('https://editor.grove.example/a?b=1&c=2#d');
    });
});
