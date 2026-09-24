// The manifest as a file in the game, the templates a new game is seeded from, and what a compile
// makes of the two together.

import { describe, expect, it } from 'vitest';
import { ProjectFormatError } from '@platform/project';
import { compile, summarize } from '../src/project/compile';
import {
    PROJECT_PATH,
    isProjectFile,
    projectDraft,
    readProject,
    sameStamp,
    stamp,
    withSettings,
    writeProject,
} from '../src/project/manifest';
import { DEFAULT_TEMPLATE, TEMPLATES, seedFrom, templateById } from '../src/workspace/templates';
import { draftFromText } from '../src/workspace/files';
import { PLAIN_PROJECT, PROJECT, TEMPLATE_PATH, templateDrafts } from './doubles';

const EMIT_NOTHING = async (): Promise<{ modules: Record<string, string>; problems: [] }> => ({
    modules: {},
    problems: [],
});

describe('the manifest as a file', () => {
    it('is one the explorer keeps out of the tree', () => {
        expect(isProjectFile(PROJECT_PATH)).toBe(true);
        expect(isProjectFile('src/player.ts')).toBe(false);
    });

    it('round-trips through the bytes a save sends', () => {
        const draft = projectDraft(PROJECT);
        expect(draft.path).toBe(PROJECT_PATH);
        expect(draft.contentType).toBe('application/json');
        expect(readProject(draft.text ?? '')).toEqual(PROJECT);
        expect(writeProject(PROJECT).endsWith('\n')).toBe(true);
    });

    it('refuses a file this build cannot read rather than repairing it', () => {
        expect(() => readProject('{"formatVersion":99}')).toThrow(ProjectFormatError);
        expect(() =>
            readProject(
                writeProject({ ...PROJECT, settings: { ...PROJECT.settings, simRate: 0 } }),
            ),
        ).toThrow(/simRate/u);
    });

    it('replaces the settings and leaves what the code declares alone', () => {
        const next = withSettings(PROJECT, { ...PROJECT.settings, maxPlayers: 8 });
        expect(next.settings.maxPlayers).toBe(8);
        expect(next.scriptModules).toEqual(PROJECT.scriptModules);
    });

    it('digests what was authored, so the same game twice is the same stamp', async () => {
        const sources = new Map([['src/player.ts', 'export const a = 1;']]);
        const once = await stamp(PROJECT, PROJECT.scriptModules, sources);
        const twice = await stamp(PROJECT, PROJECT.scriptModules, sources);
        expect(once.contentHash).toMatch(/^[\da-f]{64}$/u);
        expect(sameStamp(once, twice)).toBe(true);

        const edited = await stamp(
            PROJECT,
            PROJECT.scriptModules,
            new Map([['src/player.ts', 'export const a = 2;']]),
        );
        expect(sameStamp(once, edited)).toBe(false);
    });
});

describe('the templates a new game opens as', () => {
    it('is a list, and an id this build does not know still opens something', () => {
        expect(TEMPLATES).toContain(DEFAULT_TEMPLATE);
        expect(templateById(DEFAULT_TEMPLATE.id)).toBe(DEFAULT_TEMPLATE);
        expect(templateById('a-template-from-another-build')).toBe(DEFAULT_TEMPLATE);
        expect(templateById(undefined)).toBe(DEFAULT_TEMPLATE);
    });

    it('seeds the sources and the manifest that describes them', async () => {
        const seed = await seedFrom(DEFAULT_TEMPLATE, 'a-game-id');
        expect(seed.files.map((file) => file.path)).toEqual([TEMPLATE_PATH, PROJECT_PATH]);
        expect(seed.project.projectId).toBe('a-game-id');
        // The classes are read off the seeded code rather than written into the template twice.
        expect(seed.project.scriptModules[0]?.scripts.map((script) => script.export)).toEqual([
            'Walk',
            'Rules',
        ]);
        expect(readProject(writeProject(seed.project))).toEqual(seed.project);
    });
});

describe('compiling a game', () => {
    it('stamps the manifest from the code and says what it built', async () => {
        const { version, problems } = await compile({
            files: templateDrafts(),
            project: PROJECT,
            emit: EMIT_NOTHING,
        });
        expect(problems).toEqual([]);
        expect(version?.needsEngine).toBe(true);
        expect(version?.project.contentHash).not.toBe(PROJECT.contentHash);
        expect(summarize(version!)).toBe(
            'Build succeeded: 2 scripts in 1 file — 30 Hz, up to 4 players',
        );
    });

    it('puts the import back above the module the editor hid it from', async () => {
        const { version } = await compile({
            files: templateDrafts(),
            project: PROJECT,
            emit: async () => ({
                modules: { 'src/player.js': 'export class Walk extends TopDownMovement {}\n' },
                problems: [],
            }),
        });
        expect(version?.modules['src/player.js']).toBe(
            'import { ServerScript, onPlayerJoin, Game, ' +
                "TopDownMovement } from '@platform/engine';\n" +
                'export class Walk extends TopDownMovement {}\n',
        );
    });

    it('builds nothing from a broken parse, because the manifest would claim classes it lost', async () => {
        const { version, problems } = await compile({
            files: templateDrafts(),
            project: PROJECT,
            emit: async () => ({
                modules: {},
                problems: [
                    {
                        path: TEMPLATE_PATH,
                        line: 1,
                        column: 1,
                        message: "')' expected",
                        severity: 'error' as const,
                        syntactic: true,
                    },
                ],
            }),
        });
        expect(version).toBeNull();
        expect(problems).toHaveLength(1);
    });

    it('refuses a manifest the format would refuse, and names what is wrong with it', async () => {
        const { version, problems } = await compile({
            files: templateDrafts(),
            // Attached to a script no file declares, which is what a rename leaves behind.
            project: { ...PROJECT, gameScripts: [{ script: 'src/gone#Rules' as never }] },
            emit: EMIT_NOTHING,
        });
        expect(version).toBeNull();
        expect(problems.at(-1)?.path).toBe(PROJECT_PATH);
        expect(problems.at(-1)?.message).toContain('gameScripts');
    });

    it('warns about a class it could not declare and builds the rest', async () => {
        const { version, problems } = await compile({
            files: [draftFromText('src/main.ts', 'export class Rules extends ServerScript {}\n')],
            project: { ...PLAIN_PROJECT, gameScripts: [] },
            emit: EMIT_NOTHING,
        });
        expect(version).not.toBeNull();
        expect(problems[0]?.severity).toBe('warning');
        expect(problems[0]?.message).toContain('needs the host it attaches to');
    });

    it('knows a game of plain TypeScript needs no engine under it', async () => {
        const { version } = await compile({
            files: [draftFromText('src/main.ts', 'console.log("hello");\n')],
            project: PLAIN_PROJECT,
            emit: async () => ({
                modules: { 'src/main.js': 'console.log("hello");\n' },
                problems: [],
            }),
        });
        expect(version?.needsEngine).toBe(false);
        expect(version?.modules['src/main.js']).toBe('console.log("hello");\n');
    });
});
