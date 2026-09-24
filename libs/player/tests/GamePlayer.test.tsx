// The surface itself: what it dials with, what it tells its host about a join, and what a
// teardown takes back.
//
// The renderer and the dial are injected, because the real ones want a GPU and a socket. What is
// asserted is this component's own job — the order it does things in, the credential it presents,
// and the failure it turns each refusal into.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ConnectOptions } from '@platform/glue/client';
import type { IRenderer } from '@platform/renderer';
import { GamePlayer, ticketProtocol } from '../src/GamePlayer.js';
import type { RefusalReason } from '../src/GamePlayer.js';

beforeAll(() => {
    // React refuses to run `act` without it, and says so at the first render rather than at setup.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const PROJECT = { projectId: 'leaf-harvest', projectHash: 'a'.repeat(64) };
const DESIGN = { width: 960, height: 540 };

/** A renderer that needs no GPU, and remembers what it was asked. */
function fakeRenderer(): IRenderer & { inits: unknown[]; destroyed: number } {
    const spy = {
        inits: [] as unknown[],
        destroyed: 0,
        init: async (options: unknown) => {
            spy.inits.push(options);
        },
        destroy: () => {
            spy.destroyed += 1;
        },
    };
    return spy as unknown as IRenderer & { inits: unknown[]; destroyed: number };
}

/** A dial that never opens a socket, and hands back the state changes a test scripts. */
function fakeConnect(script: (opts: ConnectOptions) => void = () => undefined) {
    const dialled: ConnectOptions[] = [];
    let closed = 0;

    const connect = async (opts: ConnectOptions) => {
        dialled.push(opts);
        script(opts);
        return { close: () => (closed += 1) } as never;
    };
    return { connect: connect as never, dialled, closedCount: () => closed };
}

async function mount(props: Partial<Parameters<typeof GamePlayer>[0]> = {}) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const renderer = fakeRenderer();
    const dial = props.connect === undefined ? fakeConnect() : undefined;

    await act(async () => {
        root.render(
            <GamePlayer
                authority={{
                    kind: 'remote',
                    serverUrl: 'wss://box.example/play',
                    ticket: 'a-signed-ticket',
                }}
                project={PROJECT}
                name="Ray"
                design={DESIGN}
                createRenderer={() => renderer}
                {...(dial === undefined ? {} : { connect: dial.connect })}
                {...props}
            />,
        );
    });

    return { host, root, renderer, dial };
}

describe('the game surface', () => {
    it('presents the ticket as a subprotocol, never in the url', async () => {
        const { dial } = await mount();

        // A browser cannot set a header on `new WebSocket(url)`, and a url reaches access logs,
        // proxy traces and `Referer` — which is the whole reason the ticket rides here.
        expect(dial?.dialled[0]?.protocols).toEqual([ticketProtocol('a-signed-ticket')]);
        expect(dial?.dialled[0]?.url).toBe('wss://box.example/play');
        expect(dial?.dialled[0]?.url).not.toContain('a-signed-ticket');
    });

    it('binds WASD and the arrows onto the move axes, without being asked', async () => {
        // moveX/moveY are the engine's fixed axes, not a creator's own — a game with a movement
        // class and nobody having composed a binding table would otherwise never move at all.
        const { dial } = await mount();

        const bindings = dial?.dialled[0]?.bindings ?? [];
        expect(bindings).toContainEqual({
            kind: 'axis',
            code: 'keys:KeyD',
            action: 'moveX',
            polarity: 1,
        });
        expect(bindings).toContainEqual({
            kind: 'axis',
            code: 'keys:ArrowUp',
            action: 'moveY',
            polarity: 1,
        });
    });

    it('claims the identity it was handed, which is what admits it at all', async () => {
        const { dial } = await mount();

        // Only `bundleHash` has an empty-string escape at the handshake, so a session declaring
        // nothing here is refused by every world that declares a project.
        expect(dial?.dialled[0]?.project).toEqual(PROJECT);
    });

    it('brings a bundle source, so the welcome can name code for it to fetch', async () => {
        const { dial } = await mount();

        // Absent, a welcome naming a url fails the session outright: going live without the code
        // is the divergence the hash exists to catch.
        expect(dial?.dialled[0]?.bundle).toBeDefined();
    });

    it('builds the renderer against the stage the game was authored for', async () => {
        const { renderer } = await mount();

        expect(renderer.inits).toHaveLength(1);
        expect(renderer.inits[0]).toMatchObject({ design: DESIGN });
    });

    it('grounds the stage in white, not the renderer’s own black', async () => {
        // A game with no art draws nothing, and on black that is indistinguishable from a stage
        // that never came up — which is the one thing a creator pressing Play needs to tell apart.
        const { renderer } = await mount();
        expect(renderer.inits[0]).toMatchObject({ background: 0xffffff });
    });

    it('lets a host ground it in something else', async () => {
        const { renderer } = await mount({ background: 'transparent' });
        expect(renderer.inits[0]).toMatchObject({ background: 'transparent' });
    });

    it('dials only once the renderer is up, since the session is handed one', async () => {
        const order: string[] = [];
        const renderer = fakeRenderer();
        const host = document.createElement('div');
        document.body.append(host);

        await act(async () => {
            createRoot(host).render(
                <GamePlayer
                    authority={{ kind: 'remote', serverUrl: 'wss://box.example/play', ticket: 't' }}
                    project={PROJECT}
                    name="Ray"
                    design={DESIGN}
                    createRenderer={() => {
                        order.push('renderer');
                        return renderer;
                    }}
                    connect={
                        (async () => {
                            order.push('dial');
                            return { close: () => undefined } as never;
                        }) as never
                    }
                />,
            );
        });

        expect(order).toEqual(['renderer', 'dial']);
    });

    it('tells its host the moment the session is live', async () => {
        let ready = 0;
        await mount({
            onReady: () => {
                ready += 1;
            },
            connect: (async (opts: ConnectOptions) => {
                opts.onState?.('live', undefined);
                return { close: () => undefined } as never;
            }) as never,
        });

        expect(ready).toBe(1);
    });

    it('turns each refusal into something a person can act on', async () => {
        const cases: Array<[unknown, RefusalReason, RegExp]> = [
            [{ kind: 'rejected', reason: 'full', serverProtocolVersion: 1 }, 'full', /is full/u],
            [
                { kind: 'rejected', reason: 'version', serverProtocolVersion: 1 },
                'version',
                /different version/u,
            ],
            [{ kind: 'bundle', message: 'the code did not match' }, 'bundle', /did not match/u],
            // A token this build has no wording for is a refusal, never whichever case was last.
            [
                { kind: 'rejected', reason: 'a-reason-from-the-future', serverProtocolVersion: 1 },
                'unreachable',
                /turned the join away/u,
            ],
        ];

        for (const [failure, reason, message] of cases) {
            const seen: Array<[RefusalReason, string]> = [];
            // oxlint-disable-next-line no-await-in-loop
            await mount({
                onRefused: (why, text) => seen.push([why, text]),
                connect: (async (opts: ConnectOptions) => {
                    opts.onState?.('failed', failure as never);
                    return { close: () => undefined } as never;
                }) as never,
            });

            expect(seen[0]?.[0]).toBe(reason);
            expect(seen[0]?.[1]).toMatch(message);
        }
    });

    it('reports a dial that never connected rather than throwing into the mount', async () => {
        const seen: Array<[RefusalReason, string]> = [];
        await mount({
            onRefused: (why, text) => seen.push([why, text]),
            connect: (async () => {
                throw new Error('the socket was refused');
            }) as never,
        });

        expect(seen[0]).toEqual(['unreachable', 'the socket was refused']);
    });

    it('closes the session and the renderer on the way out, and empties its host', async () => {
        const { host, root, renderer, dial } = await mount();

        await act(async () => {
            root.unmount();
        });

        expect(dial?.closedCount()).toBe(1);
        expect(renderer.destroyed).toBe(1);
        expect(host.innerHTML).toBe('');
    });

    it('destroys nothing the renderer never built, for a mount torn down mid-init', async () => {
        const renderer = fakeRenderer();
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        (renderer as unknown as { init: () => Promise<void> }).init = () => held;

        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);

        await act(async () => {
            root.render(
                <GamePlayer
                    authority={{ kind: 'remote', serverUrl: 'wss://box.example/play', ticket: 't' }}
                    project={PROJECT}
                    name="Ray"
                    design={DESIGN}
                    createRenderer={() => renderer}
                    connect={(async () => ({ close: () => undefined })) as never}
                />,
            );
        });
        await act(async () => {
            root.unmount();
        });

        // The cleanup ran while init was still in flight, so it destroyed nothing; the init path
        // owns that case, and destroys once it has something to destroy.
        expect(renderer.destroyed).toBe(0);

        await act(async () => {
            release();
            await held;
        });
        expect(renderer.destroyed).toBe(1);
    });
});

/** A pair whose other end a caller already holds, and a count of what turned it. */
function fakeLink() {
    const spy = { pumps: 0, closed: 0, opened: 0 };
    const transport = {
        send: () => undefined,
        sendEncoded: () => undefined,
        onMessage: () => () => undefined,
        close: () => undefined,
    };
    const open = () => {
        spy.opened += 1;
        return {
            transport: transport as never,
            pump: () => {
                spy.pumps += 1;
            },
            close: () => {
                spy.closed += 1;
            },
        };
    };
    return { spy, open };
}

describe('a world in this page', () => {
    /** A registry the caller already holds, since nothing is fetched for a local world. */
    const scripts = { resolve: () => undefined, locationOf: () => undefined } as never;

    async function mountLocal(link = fakeLink()) {
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        const renderer = fakeRenderer();

        await act(async () => {
            root.render(
                <GamePlayer
                    authority={{ kind: 'local', open: link.open, scripts }}
                    project={PROJECT}
                    name="Ray"
                    design={DESIGN}
                    createRenderer={() => renderer}
                />,
            );
        });
        return { host, root, renderer, link };
    }

    it('opens the pair rather than dialling anything', async () => {
        const { link, host } = await mountLocal();

        // No socket, no ticket, no url: the other end is already in this page, which is the whole
        // of what a preview does differently from a deployed session.
        expect(link.spy.opened).toBe(1);
        expect(host.querySelector('.grove-stage')).not.toBeNull();
    });

    it('builds the renderer first here too, since the session is handed one', async () => {
        const { renderer } = await mountLocal();

        expect(renderer.inits).toHaveLength(1);
        expect(renderer.inits[0]).toMatchObject({ design: DESIGN });
    });

    it('ends the authority after the session, not before it', async () => {
        const { root, link, renderer } = await mountLocal();

        await act(async () => {
            root.unmount();
        });

        // The world is this page's, so its teardown is too — and it outlives the peer leaving it.
        expect(link.spy.closed).toBe(1);
        expect(renderer.destroyed).toBe(1);
    });
});
