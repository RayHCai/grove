// Addresses, both ways: what a path parses into, and what a route is written back as.

import { describe, expect, it } from 'vitest';
import { hrefOf, needsAnonymity, needsSession, parseRoute } from '../src/router/routes';

describe('reading an address', () => {
    it('reads every page this origin has', () => {
        expect(parseRoute('/')).toEqual({ at: 'landing' });
        expect(parseRoute('/forgot-password')).toEqual({ at: 'forgot-password' });
        expect(parseRoute('/games')).toEqual({ at: 'games' });
        expect(parseRoute('/profile')).toEqual({ at: 'profile' });
    });

    it('reads the way back the editor sends somebody here with', () => {
        const back = 'http://localhost:5176/?a=1';
        expect(parseRoute(`/sign-in?return=${encodeURIComponent(back)}`)).toEqual({
            at: 'sign-in',
            returnTo: back,
        });
    });

    it('reads a sign-in nobody was sent to as carrying no way back', () => {
        expect(parseRoute('/sign-in')).toEqual({ at: 'sign-in', returnTo: undefined });
        expect(parseRoute('/sign-up')).toEqual({ at: 'sign-up', returnTo: undefined });
    });

    it('reads the key out of the link a reset mail carries', () => {
        expect(parseRoute('/reset-password?token=abc')).toEqual({
            at: 'reset-password',
            token: 'abc',
        });
        expect(parseRoute('/reset-password')).toEqual({ at: 'reset-password', token: undefined });
    });

    it('treats a trailing slash as the same address', () => {
        expect(parseRoute('/games/')).toEqual({ at: 'games' });
        expect(parseRoute('/')).toEqual({ at: 'landing' });
    });

    it('names an address it has no page for rather than guessing one', () => {
        expect(parseRoute('/nowhere')).toEqual({ at: 'missing', path: '/nowhere' });
    });
});

describe('writing an address', () => {
    it('round-trips every route through its own href', () => {
        const routes = [
            { at: 'landing' },
            { at: 'sign-in', returnTo: undefined },
            { at: 'sign-up', returnTo: undefined },
            { at: 'forgot-password' },
            { at: 'games' },
            { at: 'profile' },
        ] as const;
        for (const route of routes) expect(parseRoute(hrefOf(route))).toEqual(route);
    });

    it('carries the way back through a link from sign-in to sign-up', () => {
        const back = 'http://localhost:5176/?mode=code';
        expect(parseRoute(hrefOf({ at: 'sign-up', returnTo: back }))).toEqual({
            at: 'sign-up',
            returnTo: back,
        });
    });

    it('never writes the reset key back into an address', () => {
        // The page takes it out of the address bar on sight; a function that could put it back
        // would be a way to put it in a history entry and a `Referer`.
        expect(hrefOf({ at: 'reset-password', token: 'abc' })).toBe('/reset-password');
    });
});

describe('what a route needs', () => {
    it('knows the pages that mean nothing without a session', () => {
        expect(needsSession({ at: 'games' })).toBe(true);
        expect(needsSession({ at: 'profile' })).toBe(true);
        expect(needsSession({ at: 'landing' })).toBe(false);
        expect(needsSession({ at: 'reset-password', token: undefined })).toBe(false);
    });

    it('knows the pages a holder of one has nothing to do on', () => {
        expect(needsAnonymity({ at: 'sign-in', returnTo: undefined })).toBe(true);
        expect(needsAnonymity({ at: 'sign-up', returnTo: undefined })).toBe(true);
        // Not the reset pages: somebody signed in on this tab may still be resetting a password.
        expect(needsAnonymity({ at: 'forgot-password' })).toBe(false);
        expect(needsAnonymity({ at: 'reset-password', token: undefined })).toBe(false);
    });
});
