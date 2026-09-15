// The surface itself: what a mount puts in the host, and that an unmount takes it back out.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { GamePlayer } from '../src/GamePlayer.js';

beforeAll(() => {
    // React refuses to run `act` without it, and says so at the first render rather than at setup.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('the game surface', () => {
    it('mounts a canvas addressed at the authority it was given', async () => {
        const host = document.createElement('div');
        document.body.append(host);

        await act(async () => {
            createRoot(host).render(<GamePlayer serverUrl="wss://example.invalid" ticket="t" />);
        });

        expect(host.querySelector('canvas')?.getAttribute('data-server')).toBe(
            'wss://example.invalid',
        );
    });

    it('leaves its host empty once unmounted', async () => {
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);

        await act(async () => {
            root.render(<GamePlayer serverUrl="wss://example.invalid" ticket="t" />);
        });
        await act(async () => {
            root.unmount();
        });

        expect(host.innerHTML).toBe('');
    });

    it('holds no session, so the ticket and the callbacks it is handed reach nothing', async () => {
        const host = document.createElement('div');
        document.body.append(host);
        let ready = 0;

        await act(async () => {
            createRoot(host).render(
                <GamePlayer
                    serverUrl="wss://example.invalid"
                    ticket="t"
                    onReady={() => {
                        ready += 1;
                    }}
                />,
            );
        });

        // Pinned as inert rather than left unasserted: these props are the contract a mount fills.
        const canvas = host.querySelector('canvas');
        expect(canvas?.getAttributeNames()).toEqual(['data-server']);
        expect(ready).toBe(0);
    });
});
