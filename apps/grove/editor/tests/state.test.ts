import { describe, expect, it } from 'vitest';
import type { Workspace } from '@grove/api-contract';
import { draftFromText, NOTHING_PENDING } from '../src/workspace/files';
import { initialWorkspace, workspaceReducer } from '../src/workspace/state';
import type { WorkspaceState } from '../src/workspace/state';
import { GAME, opened } from './doubles';

const MAIN = 'src/main.ts';

function clean(): WorkspaceState {
    return initialWorkspace(
        opened({
            files: [draftFromText(MAIN, 'const a = 1;')],
            saved: [
                {
                    path: MAIN,
                    kind: 'source',
                    versionId: 'v1',
                    byteLength: 12,
                    contentType: 'text/typescript',
                },
            ],
            seeded: false,
        }),
    );
}

describe('the workspace state', () => {
    it('owes a seeded template in full, and a stored game nothing', () => {
        expect([...initialWorkspace(opened()).pending.upserted].length).toBeGreaterThan(0);
        expect(clean().pending).toBe(NOTHING_PENDING);
    });

    it('owes a path once it is typed in', () => {
        const next = workspaceReducer(clean(), { type: 'edit', path: MAIN, text: 'const a = 2;' });
        expect(next.files[0]?.text).toBe('const a = 2;');
        expect([...next.pending.upserted]).toEqual([MAIN]);
    });

    it('adds nothing over a name that is taken', () => {
        const state = clean();
        expect(workspaceReducer(state, { type: 'add', path: MAIN })).toBe(state);
    });

    it('sends a delete only for a path the service has heard of', () => {
        const added = workspaceReducer(clean(), { type: 'add', path: 'src/enemy.ts' });
        const dropped = workspaceReducer(added, { type: 'remove', path: 'src/enemy.ts' });
        expect(dropped.pending.removed.size).toBe(0);
        const removed = workspaceReducer(clean(), { type: 'remove', path: MAIN });
        expect([...removed.pending.removed]).toEqual([MAIN]);
    });

    it('keeps owing a path typed in again while its save was in flight', () => {
        const typed = workspaceReducer(clean(), { type: 'edit', path: MAIN, text: 'const a = 2;' });
        const drafts = new Map(typed.files.map((file) => [file.path, file]));
        const again = workspaceReducer(typed, { type: 'edit', path: MAIN, text: 'const a = 3;' });
        const workspace: Workspace = {
            gameId: GAME.gameId,
            revision: 2,
            files: typed.saved.slice(),
            updatedAt: '2026-09-29T00:00:00.000Z',
        };

        const settled = workspaceReducer(again, {
            type: 'saved',
            workspace,
            sent: typed.pending,
            drafts,
        });
        expect(settled.revision).toBe(2);
        expect([...settled.pending.upserted]).toEqual([MAIN]);

        const quiet = workspaceReducer(typed, {
            type: 'saved',
            workspace,
            sent: typed.pending,
            drafts,
        });
        expect(quiet.pending.upserted.size).toBe(0);
    });

    it('owes nothing after a reload', () => {
        const typed = workspaceReducer(clean(), { type: 'edit', path: MAIN, text: 'const a = 2;' });
        const reloaded = workspaceReducer(typed, {
            type: 'reloaded',
            revision: 7,
            saved: typed.saved,
            files: clean().files,
            project: typed.project,
        });
        expect(reloaded.revision).toBe(7);
        expect(reloaded.files[0]?.text).toBe('const a = 1;');
        expect(reloaded.pending).toBe(NOTHING_PENDING);
    });
});
