// That a run logging every tick redraws nothing of the workbench: the pane is the one subscriber.

import { Profiler, act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@grove/ui';
import { mount, until, untilSettled } from '@grove/ui/testing';
import { mountEditor } from '../src/editor/monaco';
import { CHANNEL } from '../src/run/protocol';
import { EditorShell } from '../src/shell/EditorShell';
import { draftFromText } from '../src/workspace/files';
import { PLAIN_PROJECT, fakeApi, opened } from './doubles';

// A pane that subscribes to nothing, so any commit left after a burst is the workbench's own.
vi.mock('../src/console/ConsolePane', () => ({ ConsolePane: () => null }));

describe('a run that logs every tick', () => {
    it('re-renders nothing of the workbench, however much it writes', async () => {
        let commits = 0;
        const host = await mount(
            <Profiler id="shell" onRender={() => (commits += 1)}>
                <ThemeProvider>
                    <EditorShell
                        api={fakeApi()}
                        opened={opened({
                            files: [draftFromText('src/main.ts', 'console.log("tick");')],
                            project: PLAIN_PROJECT,
                            openPath: 'src/main.ts',
                        })}
                        onSessionLapsed={vi.fn()}
                    />
                </ThemeProvider>
            </Profiler>,
        );
        await untilSettled(host);
        const handle = vi.mocked(mountEditor).mock.results.at(-1)?.value as {
            emit: ReturnType<typeof vi.fn>;
        };
        handle.emit.mockResolvedValue({ modules: { 'src/main.js': '' }, problems: [] });

        await act(async () => {
            host.querySelector<HTMLButtonElement>('.transport__play')?.click();
        });
        const frame = host.querySelector<HTMLIFrameElement>('.play-frame');
        await until(() => (frame?.getAttribute('src') ?? '').includes('run='), 10_000);
        const run = new URL(frame?.src ?? '').searchParams.get('run');
        // Settle the frames the compile's own lines asked for before counting.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });
        const before = commits;

        await act(async () => {
            for (let tick = 0; tick < 1_000; tick += 1) {
                window.dispatchEvent(
                    new MessageEvent('message', {
                        source: frame?.contentWindow as Window,
                        data: { channel: CHANNEL, run, type: 'line', level: 'log', text: 'tick' },
                    }),
                );
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        });

        expect(commits).toBe(before);
    });
});
