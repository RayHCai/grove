// What a person sees between arriving here and playing, and what they are told when they will not.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { GameId, SessionId } from '@grove/api-contract';
import type { PlayHandoff } from '@grove/api-contract';
import type * as PlayerModule from '@grove/player';
import { App } from '../src/App';
import { encodeHandoff } from '../src/handoff';

beforeAll(() => {
    // React refuses to run `act` without it, and says so at the first render rather than at setup.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

// The surface is its own suite's. What this file is about is the shell around it: which of the
// three things a person can be looking at is on screen, and why.
const mounted = vi.hoisted(() => ({
    props: [] as Array<Record<string, unknown>>,
    refuse: undefined as ((reason: string, message: string) => void) | undefined,
    ready: undefined as (() => void) | undefined,
}));

vi.mock('@grove/player', async (importOriginal) => ({
    // The stage size is a shared constant rather than this app's, so it comes from the real module
    // — a mock of its own would be this test agreeing with itself about a number it does not own.
    ...(await importOriginal<typeof PlayerModule>()),
    GamePlayer: (props: Record<string, unknown>) => {
        mounted.props.push(props);
        mounted.ready = props['onReady'] as () => void;
        mounted.refuse = props['onRefused'] as (reason: string, message: string) => void;
        return <canvas data-testid="stage" />;
    },
}));

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

async function render(fragment: string, props: Record<string, unknown> = {}) {
    mounted.props.length = 0;
    const host = document.createElement('div');
    document.body.append(host);

    await act(async () => {
        createRoot(host).render(<App fragment={fragment} navigate={() => undefined} {...props} />);
    });
    return host;
}

describe('arriving on the player origin', () => {
    it('shows a loading screen while the session dials', async () => {
        const host = await render(`#${encodeHandoff(HANDOFF)}`);

        expect(host.querySelector('[role="status"]')?.textContent).toMatch(/Loading/u);
        expect(host.querySelector('canvas')).not.toBeNull();
    });

    it('hands the surface the address, the ticket and the identity from the fragment', async () => {
        await render(`#${encodeHandoff(HANDOFF)}`);

        expect(mounted.props[0]).toMatchObject({
            // A deployed world: the surface dials it, where a preview would hand over a pair.
            authority: {
                kind: 'remote',
                serverUrl: HANDOFF.session.serverUrl,
                ticket: HANDOFF.session.ticket,
            },
            project: {
                projectId: HANDOFF.session.projectId,
                projectHash: HANDOFF.session.projectHash,
            },
        });
    });

    it('mounts the surface under the loading screen, not after it', async () => {
        // Swapping the tree once the session went live would tear its renderer down and start the
        // join over, so the canvas is there from the first paint and the screen sits on top.
        const host = await render(`#${encodeHandoff(HANDOFF)}`);
        const before = host.querySelector('canvas');
        expect(before).not.toBeNull();

        await act(async () => {
            mounted.ready?.();
        });

        expect(host.querySelector('[role="status"]')).toBeNull();
        // The same node, not merely another one: React reconciled rather than remounting, which
        // is what keeps the renderer and the socket the session already holds.
        expect(host.querySelector('canvas')).toBe(before);
    });

    it('tells somebody who opened this origin directly what it is for', async () => {
        const host = await render('');

        expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/opened from a game/u);
        expect(host.querySelector('canvas')).toBeNull();
    });

    it('says a link it cannot read is a link, not a broken game', async () => {
        const host = await render('#not-one-of-ours!!');

        expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/not one this page/u);
    });

    it('sends somebody refused back to the platform rather than leaving them here', async () => {
        const visited: string[] = [];
        const host = await render(`#${encodeHandoff(HANDOFF)}`, {
            platformUrl: 'https://grove.example',
            navigate: (url: string) => visited.push(url),
        });

        await act(async () => {
            mounted.refuse?.('full', 'this game is full');
        });
        await act(async () => {
            host.querySelector('button')?.click();
        });

        expect(visited).toEqual(['https://grove.example']);
    });

    it('explains each refusal in words rather than in a token', async () => {
        const cases: Array<[string, RegExp]> = [
            ['version', /updated while you were joining/u],
            ['full', /full right now/u],
            ['ticket', /link has expired/u],
        ];

        for (const [reason, expected] of cases) {
            // oxlint-disable-next-line no-await-in-loop
            const host = await render(`#${encodeHandoff(HANDOFF)}`);
            // oxlint-disable-next-line no-await-in-loop
            await act(async () => {
                mounted.refuse?.(reason, 'a token nobody should be shown');
            });

            expect(host.querySelector('[role="alert"]')?.textContent).toMatch(expected);
        }
    });

    it('shows what the session said for a failure it has no wording of its own for', async () => {
        const host = await render(`#${encodeHandoff(HANDOFF)}`);

        await act(async () => {
            mounted.refuse?.('bundle', 'the game code does not match what the server said');
        });

        expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/does not match/u);
    });
});
