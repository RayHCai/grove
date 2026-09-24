// The one input this origin takes from anybody, which is why it is parsed rather than cast.

import { describe, expect, it } from 'vitest';
import { GameId, SessionId } from '@grove/api-contract';
import type { PlayHandoff } from '@grove/api-contract';
import { encodeHandoff, readHandoff } from '../src/handoff';

const HANDOFF: PlayHandoff = {
    gameId: GameId.parse('9f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f'),
    session: {
        sessionId: SessionId.parse('5d9a0c3b-7e21-4f44-9b0d-3c5e7a9f1b24'),
        serverUrl: 'wss://box.example:41337/play',
        ticket: 'a.signed.ticket',
        expiresAt: '2026-09-19T12:00:00.000Z',
        revision: 7,
        projectId: 'leaf-harvest',
        projectHash: 'a'.repeat(64),
    },
};

describe('reading the join out of a fragment', () => {
    it('round-trips what the platform wrote', () => {
        const read = readHandoff(`#${encodeHandoff(HANDOFF)}`);

        expect(read).toEqual({ outcome: 'joined', handoff: HANDOFF });
    });

    it('reads one with or without the hash the browser hands over', () => {
        const encoded = encodeHandoff(HANDOFF);

        expect(readHandoff(encoded)).toEqual(readHandoff(`#${encoded}`));
    });

    it('carries a name with an accent in it back out unchanged', () => {
        // `atob` answers one byte per character, so utf-8 read as latin-1 is the usual way this
        // breaks — and a display name is the usual thing it breaks on.
        const named: PlayHandoff = {
            ...HANDOFF,
            session: { ...HANDOFF.session, projectId: 'jardín-de-hojas' },
        };

        expect(readHandoff(`#${encodeHandoff(named)}`)).toMatchObject({
            handoff: { session: { projectId: 'jardín-de-hojas' } },
        });
    });

    it('is absent rather than broken for somebody who opened this origin directly', () => {
        expect(readHandoff('')).toEqual({ outcome: 'absent' });
        expect(readHandoff('#')).toEqual({ outcome: 'absent' });
    });

    it('refuses a fragment that is not one of ours', () => {
        for (const fragment of [
            '#not-base64url!!',
            `#${btoa('{"gameId":"nope"}')}`,
            `#${btoa('not json at all')}`,
            // Every member present but the session truncated, which a shortened link produces.
            `#${btoa(JSON.stringify({ gameId: HANDOFF.gameId }))}`,
        ]) {
            expect(readHandoff(fragment).outcome).toBe('unreadable');
        }
    });

    it('refuses a session missing the identity a joiner has to claim', () => {
        // Without these the handshake refuses the join, so a link that lost them is one this page
        // should say it cannot read rather than dial with and fail obscurely.
        const { projectHash: _hash, ...rest } = HANDOFF.session;
        const encoded = encodeHandoff({ ...HANDOFF, session: rest } as unknown as PlayHandoff);

        expect(readHandoff(`#${encoded}`).outcome).toBe('unreadable');
    });
});
