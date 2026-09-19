// A game's file set: the paths it will take, the ones it refuses, what one save carries, and the
// bytes a manifest is frozen as.

import { describe, expect, it } from 'vitest';
import {
    AssetUpload,
    MAX_WORKSPACE_FILES,
    Manifest,
    Workspace,
    WorkspaceFile,
    WorkspacePath,
    WorkspaceSave,
    buildPrefix,
    encodeManifest,
    manifestKey,
    objectKey,
} from '../src/workspace.js';

const GAME_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const VERSION = '3/L4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY.MTRCxf3vjVBH40Nr8X8gdRQBpUMLUo';
const OTHER_VERSION = 'nc1Y9XTHvCvlLFtEZEoFsMWsp.LQ2cnI';
/** Written out rather than escaped inline, so the character under test is unmistakable. */
const BACKSLASH = String.fromCharCode(92);

const file = (path: string, versionId = VERSION, kind = 'source'): unknown => ({
    path,
    kind,
    versionId,
    byteLength: 12,
    contentType: 'text/typescript',
});

const source = (path: string, text = 'export {};'): unknown => ({
    path,
    contentType: 'text/typescript',
    text,
});

describe('a workspace path', () => {
    it('takes the shapes a game is authored in', () => {
        for (const path of ['main.ts', 'scripts/player.ts', 'art/tile-01.png', '_x.ts']) {
            expect(WorkspacePath.safeParse(path).success).toBe(true);
        }
    });

    it('refuses one that would escape the game it belongs to', () => {
        for (const path of ['../secret.ts', 'a/../../b.ts', '/main.ts', './main.ts', 'a//b.ts']) {
            expect(WorkspacePath.safeParse(path).success).toBe(false);
        }
    });

    it('refuses a separator no archive and no URL agree on', () => {
        expect(WorkspacePath.safeParse(`scripts${BACKSLASH}player.ts`).success).toBe(false);
        expect(WorkspacePath.safeParse('a b.ts').success).toBe(false);
    });
});

describe('a file', () => {
    it('names its bytes by the version the bucket minted, punctuation and all', () => {
        expect(WorkspaceFile.safeParse(file('main.ts')).success).toBe(true);
        expect(WorkspaceFile.safeParse(file('main.ts', 'null')).success).toBe(true);
    });

    it('refuses a version id with a space in it, which no bucket mints', () => {
        expect(WorkspaceFile.safeParse(file('main.ts', 'two words')).success).toBe(false);
        expect(WorkspaceFile.safeParse(file('main.ts', '')).success).toBe(false);
    });

    it('says which half of the bucket it is in rather than leaving it to the extension', () => {
        expect(WorkspaceFile.safeParse(file('art/tile.png', VERSION, 'asset')).success).toBe(true);
        expect(WorkspaceFile.safeParse(file('art/tile.png', VERSION, 'binary')).success).toBe(
            false,
        );
    });

    it('carries a media type rather than leaving one to be guessed', () => {
        expect(
            WorkspaceFile.safeParse({ ...(file('main.ts') as object), contentType: 'typescript' })
                .success,
        ).toBe(false);
    });

    it('may be empty, which is a file a creator made and has not written to', () => {
        expect(
            WorkspaceFile.safeParse({ ...(file('main.ts') as object), byteLength: 0 }).success,
        ).toBe(true);
    });
});

describe('a save', () => {
    it('is what changed, and a save that changed nothing is still a save', () => {
        const parsed = WorkspaceSave.parse({ baseRevision: 3 });
        expect(parsed).toEqual({ baseRevision: 3, sources: [], assets: [], deletes: [] });
    });

    it('carries the text of a source and only the path of an asset', () => {
        const save = {
            baseRevision: 1,
            sources: [source('main.ts')],
            assets: ['art/tile.png'],
            deletes: ['old.ts'],
        };
        expect(WorkspaceSave.parse(save)).toEqual(save);
    });

    it('refuses a path that is upserted and deleted in one request', () => {
        const both = { baseRevision: 1, sources: [source('main.ts')], deletes: ['main.ts'] };
        expect(WorkspaceSave.safeParse(both).success).toBe(false);
    });

    it('refuses one path upserted as a source and an asset at once', () => {
        const both = {
            baseRevision: 1,
            sources: [source('art/tile.png')],
            assets: ['art/tile.png'],
        };
        expect(WorkspaceSave.safeParse(both).success).toBe(false);
    });

    it('refuses more files than one game may hold', () => {
        const sources = Array.from({ length: MAX_WORKSPACE_FILES + 1 }, (_, index) =>
            source(`f${String(index)}.ts`),
        );
        expect(WorkspaceSave.safeParse({ baseRevision: 0, sources }).success).toBe(false);
    });
});

describe('a workspace', () => {
    it('is revision zero and empty for a game nothing has saved', () => {
        const empty = {
            gameId: GAME_ID,
            revision: 0,
            files: [],
            updatedAt: '2026-09-16T12:00:00.000Z',
        };
        expect(Workspace.parse(empty)).toEqual(empty);
    });
});

describe('the manifest one save froze', () => {
    const manifest = Manifest.parse({
        gameId: GAME_ID,
        revision: 2,
        files: [file('scripts/player.ts', OTHER_VERSION), file('main.ts')],
    });

    it('encodes in path order, so one file set is one object however it arrived', () => {
        const reversed = Manifest.parse({ ...manifest, files: manifest.files.toReversed() });
        expect(encodeManifest(manifest)).toBe(encodeManifest(reversed));
        expect(encodeManifest(manifest).indexOf('main.ts')).toBeLessThan(
            encodeManifest(manifest).indexOf('scripts/player.ts'),
        );
    });

    it('carries nothing the shape does not declare', () => {
        const withExtra = { ...manifest, files: manifest.files.map((f) => ({ ...f, mode: 493 })) };
        expect(JSON.parse(encodeManifest(withExtra))).toEqual(JSON.parse(encodeManifest(manifest)));
    });

    it('refuses revision zero: nothing unsaved has ever been frozen', () => {
        expect(Manifest.safeParse({ ...manifest, revision: 0 }).success).toBe(false);
    });
});

describe('a key in the games bucket', () => {
    it('puts the game first, so one prefix covers everything one game owns', () => {
        expect(objectKey(GAME_ID as never, 'source', 'main.ts' as never)).toBe(
            `${GAME_ID}/source/main.ts`,
        );
        expect(objectKey(GAME_ID as never, 'asset', 'art/tile.png' as never)).toBe(
            `${GAME_ID}/assets/art/tile.png`,
        );
        expect(manifestKey(GAME_ID as never, 7)).toBe(`${GAME_ID}/manifests/7.json`);
        expect(buildPrefix(GAME_ID as never, 7)).toBe(`${GAME_ID}/build/7/`);
    });
});

describe('an asset upload', () => {
    it('is a URL with an expiry, because a presign nobody used records nothing', () => {
        const ticket = {
            path: 'art/tile.png',
            url: 'https://games.example/abc?X-Amz-Signature=deadbeef',
            expiresAt: '2026-09-18T12:05:00.000Z',
            maxBytes: 32 * 1024 * 1024,
        };
        expect(AssetUpload.parse(ticket)).toEqual(ticket);
    });
});
