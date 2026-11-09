import { describe, expect, it } from 'vitest';
import type { Workspace } from '@grove/api-contract';
import { NOTHING_PENDING, draftFromBytes, draftFromText } from '../src/workspace/files';
import type { Pending } from '../src/workspace/files';
import { autosaveOf, initialWorkspace, owedOf, workspaceReducer } from '../src/workspace/state';
import type { WorkspaceState } from '../src/workspace/state';
import { GAME, opened, templateDrafts } from './doubles';

const MAIN = 'src/main.ts';
const TILE = 'art/tile.png';

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

function answer(revision: number, state: WorkspaceState): Workspace {
    return {
        gameId: GAME.gameId,
        revision,
        files: state.saved.slice(),
        updatedAt: '2026-09-29T00:00:00.000Z',
    };
}

function settle(
    state: WorkspaceState,
    sent: Pending,
    held: ReadonlyMap<string, string> = new Map(),
    workspace: Workspace | undefined = answer(state.revision + 1, state),
    drafts = new Map(state.files.map((file) => [file.path, file])),
): WorkspaceState {
    return workspaceReducer(state, { type: 'saved', workspace, sent, held, drafts });
}

describe('the workspace state', () => {
    it('owes nothing on arrival, a seeded template included', () => {
        // Opening an editor is not a reason to write to somebody's game.
        expect(initialWorkspace(opened()).pending).toBe(NOTHING_PENDING);
        expect(clean().pending).toBe(NOTHING_PENDING);
    });

    it('owes a seeded template whole to a save the creator asks for', () => {
        const seeded = initialWorkspace(opened());
        expect([...owedOf(seeded).upserted].toSorted()).toEqual(
            templateDrafts()
                .map((file) => file.path)
                .toSorted(),
        );
        expect(autosaveOf(seeded)).toBe(NOTHING_PENDING);
    });

    it('owes a seeded template whole from the creator’s first edit on', () => {
        const seeded = initialWorkspace(opened());
        const typed = workspaceReducer(seeded, {
            type: 'edit',
            path: seeded.files[0]?.path ?? '',
            text: 'const b = 2;',
        });

        expect(typed.seeded).toBe(false);
        expect(typed.pending.upserted.size).toBe(seeded.files.length);
    });

    it('owes a path once it is typed in', () => {
        const next = workspaceReducer(clean(), { type: 'edit', path: MAIN, text: 'const a = 2;' });
        expect(next.files[0]?.text).toBe('const a = 2;');
        expect([...next.pending.upserted]).toEqual([MAIN]);
    });

    it('owes nothing for a keystroke in the tab describing an asset', () => {
        const state = workspaceReducer(clean(), {
            type: 'import',
            draft: draftFromBytes(TILE, new Uint8Array([1, 2, 3])),
        });
        const saved = settle(state, state.pending);

        // An asset is carried rather than edited, so typing there re-uploads nothing.
        expect(workspaceReducer(saved, { type: 'edit', path: TILE, text: 'oops' })).toBe(saved);
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

        const settled = settle(again, typed.pending, new Map(), answer(2, typed), drafts);
        expect(settled.revision).toBe(2);
        expect([...settled.pending.upserted]).toEqual([MAIN]);

        const quiet = settle(typed, typed.pending, new Map(), answer(2, typed), drafts);
        expect(quiet.pending.upserted.size).toBe(0);
    });

    it('keeps owing what a save held back, out of every save nobody asked for', () => {
        const typed = workspaceReducer(
            workspaceReducer(clean(), { type: 'edit', path: MAIN, text: 'const a = 2;' }),
            { type: 'import', draft: draftFromBytes(TILE, new Uint8Array([1, 2, 3])) },
        );
        const settled = settle(
            typed,
            { upserted: new Set([MAIN]), removed: new Set() },
            new Map([[TILE, 'art/tile.png could not be uploaded']]),
        );

        expect([...settled.pending.upserted]).toEqual([TILE]);
        expect([...settled.held.keys()]).toEqual([TILE]);
        // A held path no longer restarts the clock, so a refusal is not retried every second.
        expect(autosaveOf(settled).upserted.size).toBe(0);
        expect([...owedOf(settled).upserted]).toEqual([TILE]);
    });

    it('lets an asset held back try again once it is imported again', () => {
        const imported = workspaceReducer(clean(), {
            type: 'import',
            draft: draftFromBytes(TILE, new Uint8Array([1, 2, 3])),
        });
        const held = settle(imported, NOTHING_PENDING, new Map([[TILE, 'refused']]), undefined);
        const again = workspaceReducer(held, {
            type: 'import',
            draft: draftFromBytes(TILE, new Uint8Array([4, 5, 6])),
        });

        expect(again.held.size).toBe(0);
        expect([...autosaveOf(again).upserted]).toEqual([TILE]);
    });

    it('keeps the newest revision when an older answer arrives after it', () => {
        const typed = workspaceReducer(clean(), { type: 'edit', path: MAIN, text: 'const a = 2;' });
        const newer = settle(typed, typed.pending, new Map(), answer(5, typed));

        expect(settle(newer, typed.pending, new Map(), answer(3, typed))).toBe(newer);
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
