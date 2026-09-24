// The boilerplate a creator never sees: what the checker is given, and what the compile puts back.

import { describe, expect, it } from 'vitest';
import { engineTypeLibs } from '../src/editor/types';
import {
    ENGINE_TYPES,
    ENGINE_VALUES,
    GLOBALS_DTS,
    engineNamesIn,
    preludeFor,
} from '../src/project/prelude';

/** The names one shape of declaration in the file above spells, sorted. */
function declared(pattern: RegExp): string[] {
    return [...GLOBALS_DTS.matchAll(pattern)].map((match) => match[1] ?? '').toSorted();
}

describe('the declarations the workbench is given', () => {
    it('ships the engine as globals, so a creator writes the API rather than an import', () => {
        expect(GLOBALS_DTS).toContain('declare global');
        expect(GLOBALS_DTS).toContain('export import ServerScript = Engine.ServerScript;');
        expect(GLOBALS_DTS).toContain('type Ctx = Engine.Ctx;');
    });

    it('ships the engine entry and the packages its declarations reach', () => {
        const paths = engineTypeLibs().map((lib) => lib.filePath);
        expect(paths).toContain('file:///node_modules/@platform/engine/index.d.ts');
        expect(paths.some((path) => path.startsWith('file:///node_modules/@platform/core/'))).toBe(
            true,
        );
        // The host subpath is the composition roots a server stands a game up with.
        expect(paths.some((path) => path.includes('/engine/host/'))).toBe(false);
    });

    it('names every import at a path node resolution reaches from a bare specifier', () => {
        for (const lib of engineTypeLibs()) {
            expect(lib.filePath).toMatch(/^file:\/\/\/node_modules\/@platform\/[^/]+\/.+\.d\.ts$/u);
            expect(lib.filePath).not.toContain('/dist/');
        }
    });

    // What the build service compiles from is `@platform/scripting`'s two lists, and what the
    // workbench checks against is the file below. A name in one and not the other is a game that
    // typechecks on screen and fails to compile on a build box, or the reverse.
    it('declares exactly the names the lists a compile puts back are built from', () => {
        expect(declared(/^\s*export import (\w+) = Engine\./gmu)).toEqual(
            [...ENGINE_VALUES].toSorted(),
        );
        expect(declared(/^\s*type (\w+)(?:<[^>]*>)? = Engine\./gmu)).toEqual(
            [...ENGINE_TYPES].toSorted(),
        );
    });
});

describe('the import a compile puts back', () => {
    it('is only what the file reaches for', () => {
        const source =
            'export class Walk extends TopDownMovement {\n    override maxSpeed = 1;\n}\n';
        expect(preludeFor(source)).toBe("import { TopDownMovement } from '@platform/engine';\n");
    });

    it('is nothing at all for a file that names no engine', () => {
        expect(preludeFor('export const two = 1 + 1;\n')).toBe('');
    });

    it('keeps the engine order, whatever order the file used the names in', () => {
        const source =
            'class A extends SyncedScript<Entity> { @onStart go() { game.spawn("x"); } }';
        expect(engineNamesIn(source)).toEqual(['SyncedScript', 'onStart', 'Entity', 'game']);
    });

    it('passes over a member read, which is somebody else’s name', () => {
        expect(preludeFor('console.log("hello");\n')).toBe('');
        expect(preludeFor('this.host.camera.follow(this.host.avatar);\n')).toBe('');
    });

    it('passes over a word in a comment or a string', () => {
        expect(preludeFor('// the game is the world\nexport const a = 1;\n')).toBe('');
        expect(preludeFor('export const note = "ask the hud";\n')).toBe('');
    });

    it('leaves a name the file declares itself alone, which the checker also lets shadow', () => {
        const source =
            'export class Storage {\n    keep(): void {}\n}\nconst held = new Storage();\n';
        expect(preludeFor(source)).toBe('');
    });

    it('imports values only, since a type is erased before anything is emitted', () => {
        expect(ENGINE_VALUES).toContain('ServerScript');
        expect(ENGINE_VALUES).not.toContain('Ctx');
        expect(ENGINE_VALUES).not.toContain('Host');
    });
});
