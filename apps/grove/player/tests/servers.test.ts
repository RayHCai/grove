// Which sockets this origin will dial, since the server a link names picks the code it runs.

import { describe, expect, it } from 'vitest';
import { gameHosts, serverPolicy, socketSources, trustedServer } from '../src/servers';
import type { ServerPolicy } from '../src/servers';

const FLEET: ServerPolicy = { hosts: ['fleet.grove.example'], insecure: false };

describe('the fleet a build is told', () => {
    it('reads a comma-separated list, however its entries were written', () => {
        expect(gameHosts(' fleet.grove.example, .Edge.Grove.Example ,*.eu.grove.example,')).toEqual(
            ['fleet.grove.example', 'edge.grove.example', 'eu.grove.example'],
        );
    });

    it('is nothing at all when the variable is empty or missing', () => {
        expect(gameHosts('')).toBeUndefined();
        expect(gameHosts(' , ')).toBeUndefined();
        expect(gameHosts(undefined)).toBeUndefined();
    });

    it('is required of a production build, which would otherwise dial whatever a link names', () => {
        expect(() => serverPolicy(undefined, false)).toThrow(/VITE_GAME_HOSTS/u);
    });

    it('lets a dev server dial its local fleet, plain ws included', () => {
        expect(serverPolicy(undefined, true)).toEqual({ hosts: undefined, insecure: true });
        expect(serverPolicy('fleet.grove.example', false)).toEqual(FLEET);
    });
});

describe('a server a join names', () => {
    it('is dialled when it sits at or under one of the fleet’s hosts', () => {
        expect(trustedServer('wss://fleet.grove.example/play/a', FLEET)).toBe(true);
        expect(trustedServer('wss://box-7.fleet.grove.example:443/play/a', FLEET)).toBe(true);
        expect(trustedServer('wss://BOX-7.Fleet.Grove.Example./play/a', FLEET)).toBe(true);
    });

    it('is refused when it only ends in the same letters', () => {
        expect(trustedServer('wss://evilfleet.grove.example/play', FLEET)).toBe(false);
        expect(trustedServer('wss://fleet.grove.example.evil.example/play', FLEET)).toBe(false);
    });

    it('is refused over plain ws outside a dev server', () => {
        expect(trustedServer('ws://box-7.fleet.grove.example/play', FLEET)).toBe(false);
        expect(
            trustedServer('ws://localhost:41337/play', { hosts: undefined, insecure: true }),
        ).toBe(true);
    });

    it('is refused when it carries a credential, or is not a socket at all', () => {
        expect(trustedServer('wss://user:secret@box.fleet.grove.example/play', FLEET)).toBe(false);
        expect(trustedServer('https://box.fleet.grove.example/play', FLEET)).toBe(false);
        expect(trustedServer('not a url', FLEET)).toBe(false);
    });
});

describe('the sockets a built page’s policy allows', () => {
    it('names each host and everything under it, on any port', () => {
        expect(socketSources(['fleet.grove.example'])).toEqual([
            'wss://fleet.grove.example:*',
            'wss://*.fleet.grove.example:*',
        ]);
    });

    it('names an address literal alone, and nothing for one a policy cannot spell', () => {
        expect(socketSources(['10.0.4.7', '[::1]'])).toEqual(['wss://10.0.4.7:*']);
    });

    it('allows no socket at all for a build that was told no fleet', () => {
        expect(socketSources(undefined)).toEqual([]);
    });
});
