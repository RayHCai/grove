// The one input this origin takes from anybody, which is why it is parsed rather than cast.

import { describe, expect, it } from 'vitest';
import { GameId, SessionId } from '@grove/api-contract';
import type { PlayHandoff } from '@grove/api-contract';
import { encodeHandoff } from '@grove/api-contract';
import { readHandoff } from '../src/handoff';
import type { ServerPolicy } from '../src/servers';

const FLEET: ServerPolicy = { hosts: ['fleet.grove.example'], insecure: false };

const HANDOFF: PlayHandoff = {
    gameId: GameId.parse('9f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f'),
    session: {
        sessionId: SessionId.parse('5d9a0c3b-7e21-4f44-9b0d-3c5e7a9f1b24'),
        serverUrl: 'wss://box-7.fleet.grove.example/play/a7',
        ticket: 'a.signed.ticket',
        expiresAt: '2026-09-19T12:00:00.000Z',
        revision: 7,
        projectId: 'leaf-harvest',
        projectHash: 'a'.repeat(64),
    },
};

function pointingAt(serverUrl: string): string {
    return `#${encodeHandoff({ ...HANDOFF, session: { ...HANDOFF.session, serverUrl } })}`;
}

describe('reading the join out of a fragment', () => {
    it('round-trips what the platform wrote', () => {
        const read = readHandoff(`#${encodeHandoff(HANDOFF)}`, FLEET);

        expect(read).toEqual({ outcome: 'joined', handoff: HANDOFF });
    });

    it('reads one with or without the hash the browser hands over', () => {
        const encoded = encodeHandoff(HANDOFF);

        expect(readHandoff(encoded, FLEET)).toEqual(readHandoff(`#${encoded}`, FLEET));
    });

    it('carries a name with an accent in it back out unchanged', () => {
        // `atob` answers one byte per character, so utf-8 read as latin-1 is the usual way this
        // breaks, and a display name is the usual thing it breaks on.
        const named: PlayHandoff = {
            ...HANDOFF,
            session: { ...HANDOFF.session, projectId: 'jardín-de-hojas' },
        };

        expect(readHandoff(`#${encodeHandoff(named)}`, FLEET)).toMatchObject({
            handoff: { session: { projectId: 'jardín-de-hojas' } },
        });
    });

    it('is absent rather than broken for somebody who opened this origin directly', () => {
        expect(readHandoff('', FLEET)).toEqual({ outcome: 'absent' });
        expect(readHandoff('#', FLEET)).toEqual({ outcome: 'absent' });
    });

    it('refuses a fragment that is not one of ours', () => {
        for (const fragment of [
            '#not-base64url!!',
            `#${btoa('{"gameId":"nope"}')}`,
            `#${btoa('not json at all')}`,
            // Every member present but the session truncated, which a shortened link produces.
            `#${btoa(JSON.stringify({ gameId: HANDOFF.gameId }))}`,
        ]) {
            expect(readHandoff(fragment, FLEET).outcome).toBe('unreadable');
        }
    });

    it('refuses a session missing the identity a joiner has to claim', () => {
        // Without these the handshake refuses the join, so a link that lost them is one this page
        // should say it cannot read rather than dial with and fail obscurely.
        const { projectHash: _hash, ...rest } = HANDOFF.session;
        const encoded = encodeHandoff({ ...HANDOFF, session: rest } as unknown as PlayHandoff);

        expect(readHandoff(`#${encoded}`, FLEET).outcome).toBe('unreadable');
    });

    it('refuses a well-formed join that names a server outside the fleet', () => {
        // The server a join names is what tells this page which code to run, so a link somebody
        // wrote by hand is a link to their code.
        expect(readHandoff(pointingAt('wss://box.attacker.example/play'), FLEET).outcome).toBe(
            'untrusted',
        );
        expect(readHandoff(pointingAt('ws://box-7.fleet.grove.example/play'), FLEET).outcome).toBe(
            'untrusted',
        );
    });
});
