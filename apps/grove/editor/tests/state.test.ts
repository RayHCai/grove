import { describe, expect, it } from 'vitest';
import type { Workspace, WorkspaceFile } from '@grove/api-contract';
import { NOTHING_PENDING, draftFromBytes, draftFromText } from '../src/workspace/files';
import type { DraftFile, Pending } from '../src/workspace/files';
import {
    autosaveOf,
    conflictPath,
    initialWorkspace,
    owedOf,
    workspaceReducer,
} from '../src/workspace/state';
import type { WorkspaceState } from '../src/workspace/state';
import { GAME, opened, templateDrafts } from './doubles';

const MAIN = 'src/main.ts';
const COPY = 'src/main.conflict.ts';
const TILE = 'art/tile.png';

/** A file as the service's saved set lists it, and the draft a reload reads its text into. */
function stored(path: string, versionId: string, text: string): [WorkspaceFile, DraftFile] {
    return [
        {
            path,
            kind: 'source',
            versionId,
            byteLength: text.length,
            contentType: 'text/typescript',
        },
        draftFromText(path, text),
    ];
}

/** The reducer's answer to a conflict reload landing on these files at this revision. */
function reload(
    state: WorkspaceState,
    revision: number,
    files: [WorkspaceFile, DraftFile][],
): WorkspaceState {
    return workspaceReducer(state, {
        type: 'reloaded',
        revision,
        saved: files.map(([file]) => file),
        files: files.map(([, draft]) => draft),
        project: state.project,
    });
}

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

    it('puts a draft back on top of a reload that left its file alone', () => {
        const typed = workspaceReducer(clean(), { type: 'edit', path: MAIN, text: 'const a = 2;' });
        const reloaded = reload(typed, 7, [stored(MAIN, 'v1', 'const a = 1;')]);

        expect(reloaded.revision).toBe(7);
        expect(reloaded.files.find((file) => file.path === MAIN)?.text).toBe('const a = 2;');
        expect([...reloaded.pending.upserted]).toEqual([MAIN]);
        expect(reloaded.rebase?.copies.size).toBe(0);
    });

    it('keeps the service’s text where both changed a file, and this tab’s in a copy beside it', () => {
        const typed = workspaceReducer(clean(), { type: 'edit', path: MAIN, text: 'const a = 2;' });
        const reloaded = reload(typed, 7, [stored(MAIN, 'v9', 'const a = 3;')]);

        expect(reloaded.files.find((file) => file.path === MAIN)?.text).toBe('const a = 3;');
        expect(reloaded.files.find((file) => file.path === COPY)?.text).toBe('const a = 2;');
        // Owed as a new file, which overwrites nothing; the contested path itself is owed nothing.
        expect([...reloaded.pending.upserted]).toEqual([COPY]);
        expect([...autosaveOf(reloaded).upserted]).toEqual([COPY]);
        expect([...(reloaded.rebase?.copies ?? [])]).toEqual([[MAIN, COPY]]);
    });

    it('calls it no conflict when both sides arrived at the same text', () => {
        const typed = workspaceReducer(clean(), { type: 'edit', path: MAIN, text: 'const a = 3;' });
        const reloaded = reload(typed, 7, [stored(MAIN, 'v9', 'const a = 3;')]);

        expect(reloaded.files.map((file) => file.path)).toEqual([MAIN]);
        expect(reloaded.pending).toBe(NOTHING_PENDING);
    });

    it('carries a delete over a file nobody else touched, and drops one they edited since', () => {
        const removed = workspaceReducer(clean(), { type: 'remove', path: MAIN });

        const untouched = reload(removed, 7, [stored(MAIN, 'v1', 'const a = 1;')]);
        expect(untouched.files).toEqual([]);
        expect([...untouched.pending.removed]).toEqual([MAIN]);

        const edited = reload(removed, 7, [stored(MAIN, 'v9', 'const a = 3;')]);
        expect(edited.files.find((file) => file.path === MAIN)?.text).toBe('const a = 3;');
        expect(edited.pending).toBe(NOTHING_PENDING);
    });

    it('lets a template nothing stored give way to what the service holds', () => {
        const reloaded = reload(initialWorkspace(opened()), 3, [stored(MAIN, 'v9', 'x;')]);
        expect(reloaded.files.map((file) => file.path)).toEqual([MAIN]);
        expect(reloaded.pending).toBe(NOTHING_PENDING);
        expect(reloaded.seeded).toBe(false);
    });

    it('names a copy beside the file, past any copy already there', () => {
        expect(conflictPath('src/main.ts', new Set())).toBe('src/main.conflict.ts');
        expect(conflictPath('src/main.ts', new Set(['src/main.conflict.ts']))).toBe(
            'src/main.conflict-2.ts',
        );
        expect(conflictPath('notes/README', new Set())).toBe('notes/README.conflict');
        expect(conflictPath('a.b/file', new Set())).toBe('a.b/file.conflict');
    });
});
