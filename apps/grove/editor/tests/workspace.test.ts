// What a file is called, what one save owes the service, and what opening a game reads back.

import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import { treeOf } from '../src/project/files';
import {
    NOTHING_PENDING,
    bytesOf,
    draftFromBytes,
    draftFromText,
    dropped,
    isPending,
    isText,
    languageOf,
    mediaTypeOf,
    touched,
} from '../src/workspace/files';
import { openGame, reloadGame, saveGame, saveOf } from '../src/workspace/session';
import { PROJECT_PATH } from '../src/project/manifest';
import { scanScripts } from '../src/project/scripts';
import { DEFAULT_TEMPLATE } from '../src/workspace/templates';
import { fakeApi, GAME, GAME_ID, project, stored } from './doubles';

const SOURCE = 'export const pip = 1;\n';

/** The set after every path in `paths` was written to. */
function pendingOver(...paths: string[]): ReturnType<typeof touched> {
    return paths.reduce(touched, NOTHING_PENDING);
}

describe('naming a file', () => {
    it('is worked out from the extension, and an unknown one is opaque bytes', () => {
        expect(mediaTypeOf('src/main.ts')).toBe('text/typescript');
        expect(mediaTypeOf('art/tile.PNG')).toBe('image/png');
        expect(mediaTypeOf('save.dat')).toBe('application/octet-stream');
    });

    it('decides what the code editor may open and which grammar it opens under', () => {
        expect(isText('text/typescript')).toBe(true);
        expect(isText('application/json')).toBe(true);
        expect(isText('image/png')).toBe(false);
        expect(languageOf('src/main.ts')).toBe('typescript');
        expect(languageOf('notes.md')).toBe('plaintext');
    });
});

describe('a draft', () => {
    it('carries text when it is text, and bytes when it is not', () => {
        const code = draftFromText('src/main.ts', SOURCE);
        expect(code.text).toBe(SOURCE);
        expect(code.bytes).toBeUndefined();

        const art = draftFromBytes('art/tile.png', new Uint8Array([1, 2, 3]));
        expect(art.text).toBeUndefined();
        expect(art.bytes).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('decodes bytes that arrived for a text file, so the editor can open them', () => {
        const back = draftFromBytes('src/main.ts', new TextEncoder().encode(SOURCE));
        expect(back.text).toBe(SOURCE);
    });

    it('is the same bytes either way round', () => {
        expect(bytesOf(draftFromText('src/main.ts', SOURCE))).toEqual(
            new TextEncoder().encode(SOURCE),
        );
    });
});

describe('what a save still owes', () => {
    it('is nothing at all until something is written to', () => {
        expect(isPending(NOTHING_PENDING)).toBe(false);
        expect(isPending(touched(NOTHING_PENDING, 'src/main.ts'))).toBe(true);
    });

    it('takes back a delete when the path is written to again', () => {
        const deleted = dropped(pendingOver('src/main.ts'), 'src/main.ts', true);
        expect([...deleted.removed]).toEqual(['src/main.ts']);
        expect([...touched(deleted, 'src/main.ts').removed]).toEqual([]);
    });

    it('forgets a file made and removed before either reached the service', () => {
        // Naming it as a delete would be asking to remove whatever is at that path already.
        const gone = dropped(pendingOver('src/scratch.ts'), 'src/scratch.ts', false);
        expect(isPending(gone)).toBe(false);
    });
});

describe('what a save sends', () => {
    const drafts = [
        draftFromText('src/main.ts', SOURCE),
        draftFromText('src/untouched.ts', 'x'),
        draftFromBytes('art/tile.png', new Uint8Array([1, 2, 3])),
    ];

    it('is the text of what changed, and nothing about what did not', () => {
        const { save } = saveOf(4, drafts, pendingOver('src/main.ts'));
        expect(save).toEqual({
            baseRevision: 4,
            sources: [{ path: 'src/main.ts', contentType: 'text/typescript', text: SOURCE }],
            assets: [],
            deletes: [],
        });
    });

    it('names an asset by path alone, because its bytes never go through the API', () => {
        const { save, assets } = saveOf(4, drafts, pendingOver('art/tile.png'));
        expect(save.assets).toEqual(['art/tile.png']);
        expect(save.sources).toEqual([]);
        expect(assets.map((draft) => draft.path)).toEqual(['art/tile.png']);
    });

    it('carries the paths that were removed', () => {
        const pending = dropped(NOTHING_PENDING, 'src/old.ts', true);
        expect(saveOf(4, drafts, pending).save.deletes).toEqual(['src/old.ts']);
    });
});

describe('opening a game', () => {
    it('walks the three steps in order, and says so as it goes', async () => {
        const steps: string[] = [];
        await openGame(fakeApi(), (step) => steps.push(step));
        expect(steps).toEqual(['account', 'game', 'files']);
    });

    it('seeds the template into a game with nothing in it, and marks it as seeded', async () => {
        const open = await openGame(fakeApi(), vi.fn());
        expect(open.seeded).toBe(true);
        expect(open.revision).toBe(0);
        expect(open.saved).toEqual([]);
        expect(open.files.map((file) => file.path)).toEqual([
            ...DEFAULT_TEMPLATE.files().map((file) => file.path),
            PROJECT_PATH,
        ]);
        expect(open.openPath).toBe(DEFAULT_TEMPLATE.openPath);
    });

    it('reads a saved game back by path rather than seeding over it', async () => {
        const api = fakeApi();
        await stored(api, [draftFromText('src/main.ts', SOURCE)], 3);

        const open = await openGame(api, vi.fn());
        expect(open.seeded).toBe(false);
        expect(open.revision).toBe(3);
        expect(open.files).toHaveLength(1);
        expect(open.files[0]?.text).toBe(SOURCE);
    });

    it('makes one game and opens it when the creator owns none', async () => {
        const api = fakeApi({ owned: [] });
        const open = await openGame(api, vi.fn());
        expect(open.game.title).toBe('Untitled game');
        expect(api.owned).toHaveLength(1);
    });

    it('opens the newest of several rather than asking for a choice nobody made', async () => {
        const older = { ...GAME, gameId: GAME.gameId, title: 'Older' };
        const api = fakeApi({ owned: [GAME, older] });
        expect((await openGame(api, vi.fn())).game.title).toBe("Pip's Garden");
    });
});

describe('saving a game', () => {
    it('sends the text of what changed and nothing else', async () => {
        const api = fakeApi();
        const files = [draftFromText('src/main.ts', SOURCE), draftFromText('src/old.ts', 'x')];

        const saved = await saveGame(api, GAME_ID, 0, files, pendingOver('src/main.ts'));
        expect(saved.revision).toBe(1);
        expect(api.saves).toHaveLength(1);
        expect(api.saves[0]?.sources.map((source) => source.path)).toEqual(['src/main.ts']);
        expect(api.saves[0]?.assets).toEqual([]);
    });

    it('puts an asset in the bucket before the save names its path', async () => {
        const api = fakeApi();
        const art = draftFromBytes('art/tile.png', new Uint8Array([1, 2, 3]));

        await saveGame(api, GAME_ID, 0, [art], pendingOver('art/tile.png'));
        expect(api.signed).toEqual(['art/tile.png']);
        expect(api.bucket.get('art/tile.png')?.type).toBe('image/png');
        expect(api.saves[0]?.assets).toEqual(['art/tile.png']);
    });

    it('is refused when an asset was named and never uploaded', async () => {
        const api = fakeApi();
        vi.spyOn(api, 'putAsset').mockResolvedValue(undefined);
        const art = draftFromBytes('art/tile.png', new Uint8Array([1, 2, 3]));

        await expect(
            saveGame(api, GAME_ID, 0, [art], pendingOver('art/tile.png')),
        ).rejects.toBeInstanceOf(ApiError);
    });

    it('is how a file is removed: the save names the path as deleted', async () => {
        const api = fakeApi();
        const both = [draftFromText('a.ts', '1'), draftFromText('b.ts', '2')];
        const first = await saveGame(api, GAME_ID, 0, both, pendingOver('a.ts', 'b.ts'));

        const after = await saveGame(
            api,
            GAME_ID,
            first.revision,
            [both[0]!],
            dropped(NOTHING_PENDING, 'b.ts', true),
        );
        expect(after.files.map((file) => file.path)).toEqual(['a.ts']);
    });

    it('lets the conflict through rather than overwriting what somebody else saved', async () => {
        const api = fakeApi();
        const files = [draftFromText('src/main.ts', SOURCE)];
        await saveGame(api, GAME_ID, 0, files, pendingOver('src/main.ts'));

        await expect(
            saveGame(api, GAME_ID, 0, files, pendingOver('src/main.ts')),
        ).rejects.toBeInstanceOf(ApiError);
    });

    it('reloads what the service holds, which is what a conflict leaves the editor to do', async () => {
        const api = fakeApi();
        await stored(api, [draftFromText('src/main.ts', SOURCE)], 5);

        const current = await reloadGame(api, GAME_ID);
        expect(current.revision).toBe(5);
        expect(current.files[0]?.text).toBe(SOURCE);
    });
});

describe('the tree the explorer lists', () => {
    it('is folders above files, each side alphabetical, however the paths arrived', () => {
        const nodes = treeOf(project());
        expect(nodes.map((node) => node.path)).toEqual(['hud', 'src', 'game.config.ts']);
    });

    it('nests a folder inside a folder from the slashes alone', () => {
        const nodes = treeOf(project([draftFromText('art/tiles/grass.ts', '')]));
        const art = nodes[0];
        expect(art?.kind).toBe('folder');
        if (art?.kind !== 'folder') return;
        expect(art.children[0]?.path).toBe('art/tiles');
    });
});

describe('the default template', () => {
    it('opens on a player written against the engine, with no import in sight', () => {
        const opening = DEFAULT_TEMPLATE.files().find(
            (file) => file.path === DEFAULT_TEMPLATE.openPath,
        );
        expect(opening?.text).toContain('extends TopDownMovement');
        expect(opening?.text).toContain('@onPlayerJoin');
        // The engine is a global here; the compile is what puts an import above it.
        expect(opening?.text).not.toMatch(/^import /mu);
    });

    it('declares the game script its manifest attaches', () => {
        const attached = DEFAULT_TEMPLATE.project.gameScripts.map((each) => each.script);
        const declared = scanScripts(
            DEFAULT_TEMPLATE.files().flatMap((file) =>
                file.text === undefined ? [] : [{ path: file.path, text: file.text }],
            ),
        ).modules.flatMap((module) => module.scripts.map((script) => script.id));
        expect(declared).toEqual(expect.arrayContaining(attached));
    });
});
