// What a person sees between arriving here and playing, and what they are told when they will not.

import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GameId, SessionId, encodeHandoff } from '@grove/api-contract';
import type { PlayHandoff } from '@grove/api-contract';
import type { GamePlayerProps } from '@grove/player';
import { mount, unmountAll } from '@grove/ui/testing';
import { App } from '../src/App';
import type { ServerPolicy } from '../src/servers';

beforeAll(() => {
    // React refuses to run `act` without it, and says so at the first render rather than at setup.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
    unmountAll();
    document.body.innerHTML = '';
});

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

interface Dialled {
    url: string;
    protocols?: string[];
    project?: unknown;
    onState?: (state: string, failure?: unknown) => void;
}

// The real surface, over a renderer needing no GPU and a dial needing no socket: every refusal
// below reaches this page as the reason the session itself would give.
function noGpu(
    init: () => Promise<void> = async () => undefined,
): GamePlayerProps['createRenderer'] {
    return () => ({ init, destroy: () => undefined }) as never;
}

function dial(answer: (opts: Dialled) => Promise<unknown> = () => new Promise(() => undefined)): {
    dialled: Dialled[];
    connect: GamePlayerProps['connect'];
} {
    const dialled: Dialled[] = [];
    const connect = async (opts: Dialled) => {
        dialled.push(opts);
        return answer(opts);
    };
    return { dialled, connect: connect as never };
}

async function render(
    fragment: string,
    props: Partial<Parameters<typeof App>[0]> = {},
): Promise<HTMLElement> {
    return mount(
        <App
            fragment={fragment}
            servers={FLEET}
            platformUrl="https://grove.example"
            navigate={() => undefined}
            createRenderer={noGpu()}
            connect={dial().connect}
            {...props}
        />,
    );
}

function alert(host: HTMLElement): string {
    return host.querySelector('[role="alert"]')?.textContent ?? '';
}

describe('arriving on the player origin', () => {
    it('shows a loading screen while the session dials', async () => {
        const host = await render(`#${encodeHandoff(HANDOFF)}`);

        expect(host.querySelector('[role="status"]')?.textContent).toMatch(/Loading/u);
        expect(host.querySelector('.grove-stage')).not.toBeNull();
    });

    it('dials the address in the fragment, with its ticket and the identity it claims', async () => {
        const { dialled, connect } = dial();
        await render(`#${encodeHandoff(HANDOFF)}`, { connect });

        expect(dialled).toHaveLength(1);
        expect(dialled[0]?.url).toBe(HANDOFF.session.serverUrl);
        expect(dialled[0]?.protocols).toEqual([`grove.ticket.${HANDOFF.session.ticket}`]);
        expect(dialled[0]?.project).toEqual({
            projectId: HANDOFF.session.projectId,
            projectHash: HANDOFF.session.projectHash,
        });
    });

    it('mounts the surface under the loading screen, and keeps it once the game is live', async () => {
        let live!: () => void;
        const { dialled, connect } = dial(async (opts) => {
            live = () => opts.onState?.('live');
            return { close: () => undefined };
        });
        const host = await render(`#${encodeHandoff(HANDOFF)}`, { connect });
        const before = host.querySelector('.grove-stage');

        await act(async () => {
            live();
        });

        expect(host.querySelector('[role="status"]')).toBeNull();
        // The same node, not merely another one: swapping the tree would tear the renderer down
        // and dial again with a ticket the first dial already spent.
        expect(host.querySelector('.grove-stage')).toBe(before);
        expect(dialled).toHaveLength(1);
    });

    it('tells somebody who opened this origin directly what it is for', async () => {
        const host = await render('');

        expect(alert(host)).toMatch(/opened from a game/u);
        expect(host.querySelector('.grove-stage')).toBeNull();
    });

    it('says a link it cannot read is a link, not a broken game', async () => {
        const host = await render('#not-one-of-ours!!');

        expect(alert(host)).toMatch(/not one this page/u);
    });

    it('refuses a link to a server outside the fleet, and never dials it', async () => {
        const { dialled, connect } = dial();
        const crafted = encodeHandoff({
            ...HANDOFF,
            session: { ...HANDOFF.session, serverUrl: 'wss://box.attacker.example/play' },
        });
        const host = await render(`#${crafted}`, { connect });

        expect(alert(host)).toMatch(/does not lead to a Grove game/u);
        expect(dialled).toEqual([]);
    });

    it('sends somebody refused back to the platform rather than leaving them here', async () => {
        const visited: string[] = [];
        const { connect } = dial(async (opts) => {
            opts.onState?.('failed', {
                kind: 'rejected',
                reason: 'full',
                serverProtocolVersion: 1,
            });
            return { close: () => undefined };
        });
        const host = await render(`#${encodeHandoff(HANDOFF)}`, {
            connect,
            navigate: (url: string) => visited.push(url),
        });

        await act(async () => {
            host.querySelector('button')?.click();
        });
        expect(visited).toEqual(['https://grove.example']);
    });
});

describe('a join that does not happen', () => {
    it('explains each refusal in its own words, never in the session’s', async () => {
        const cases: Array<[unknown, RegExp]> = [
            [
                { kind: 'rejected', reason: 'version', serverProtocolVersion: 1 },
                /updated while you were joining/u,
            ],
            [{ kind: 'rejected', reason: 'full', serverProtocolVersion: 1 }, /full right now/u],
            [
                { kind: 'rejected', reason: 'identity', serverProtocolVersion: 1 },
                /already playing this game somewhere else/u,
            ],
            [
                {
                    kind: 'bundle',
                    message:
                        'the game code is at an address this client will not fetch: ftp://cdn.example/x.js',
                },
                /could not be loaded/u,
            ],
            [{ kind: 'peer', message: 'frame 12 was 9 bytes short' }, /stopped answering/u],
        ];

        for (const [failure, expected] of cases) {
            const { connect } = dial(async (opts) => {
                opts.onState?.('failed', failure);
                return { close: () => undefined };
            });
            const host = await render(`#${encodeHandoff(HANDOFF)}`, { connect });

            expect(alert(host)).toMatch(expected);
            expect(alert(host)).not.toMatch(/cdn\.example|bytes short/u);
        }
    });

    it('says a link that never connected may have expired, and never shows its address', async () => {
        const { connect } = dial(async () => {
            throw new Error(
                'The socket for wss://box-7.fleet.grove.example/play/a7 errored before it opened.',
            );
        });
        const host = await render(`#${encodeHandoff(HANDOFF)}`, { connect });

        expect(alert(host)).toMatch(/may have expired. Start the game again from Grove/u);
        expect(alert(host)).not.toContain('wss://');
        expect(alert(host)).not.toContain('fleet.grove.example');
    });

    it('says a browser that could not start the game is the browser, not the link', async () => {
        const host = await render(`#${encodeHandoff(HANDOFF)}`, {
            createRenderer: noGpu(async () => {
                throw new Error('WebGL2 is not available');
            }),
        });

        expect(alert(host)).toMatch(/This browser could not start the game/u);
        expect(alert(host)).not.toContain('WebGL2');
    });
});
