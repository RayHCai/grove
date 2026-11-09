// That nothing a creator wrote is evaluated in the editor's own page: its module graph, walked from
// the entry, holds no world, no session, and nothing that turns text into a module.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The directory, not a URL: jsdom's own URL class is not one node:url accepts.
const SRC = path.join(import.meta.dirname, '..', 'src');

/** What runs a world or a session, which only a run's sandboxed document may hold. */
const WORLD = [
    '@grove/player',
    '@platform/client',
    '@platform/core',
    '@platform/engine',
    '@platform/glue',
    '@platform/renderer',
    '@platform/sim',
];

const STATIC = /^\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gmu;
const DYNAMIC = /\bimport\(\s*([^)]*?)\s*\)/gu;

interface Reached {
    files: Set<string>;
    packages: Map<string, string>;
}

function resolveFile(from: string, specifier: string): string | undefined {
    // A `?raw` import is a file's text as a string, which nothing evaluates.
    if (specifier.includes('?')) return undefined;
    const at = path.resolve(path.dirname(from), specifier);
    return [at, `${at}.ts`, `${at}.tsx`, path.join(at, 'index.ts')].find(
        (candidate) => /\.tsx?$/u.test(candidate) && fs.existsSync(candidate),
    );
}

/** Every file and package the entry reaches through imports that are evaluated, not erased. */
function reach(entry: string): Reached {
    const reached: Reached = { files: new Set(), packages: new Map() };
    const visit = (file: string): void => {
        if (reached.files.has(file)) return;
        reached.files.add(file);
        const text = fs.readFileSync(file, 'utf8');
        for (const [, erased, specifier = ''] of text.matchAll(STATIC)) {
            if (erased !== undefined) continue;
            if (!specifier.startsWith('.')) {
                reached.packages.set(specifier, path.relative(SRC, file));
                continue;
            }
            const next = resolveFile(file, specifier);
            if (next !== undefined) visit(next);
        }
    };
    visit(entry);
    return reached;
}

const page = reach(path.join(SRC, 'main.tsx'));

describe('the editor’s own page', () => {
    it('reaches none of the code a run’s document is built from', () => {
        const preview = [...page.files].filter((file) =>
            path.relative(SRC, file).startsWith(`preview${path.sep}`),
        );
        expect(preview).toEqual([]);
    });

    it('imports no package that runs a world or a session', () => {
        const world = [...page.packages].filter(([specifier]) =>
            WORLD.some((name) => specifier === name || specifier.startsWith(`${name}/`)),
        );
        expect(world).toEqual([]);
    });

    it('turns no text into a module: no blob of code, and no import of a computed address', () => {
        for (const file of page.files) {
            const text = fs.readFileSync(file, 'utf8');
            expect(text, path.relative(SRC, file)).not.toMatch(/createObjectURL/u);
            for (const [, specifier = ''] of text.matchAll(DYNAMIC)) {
                expect(specifier, path.relative(SRC, file)).toMatch(/^(['"]).+\1$/u);
            }
        }
    });

    it('is walked by a walker that does find the engine where a world is built', () => {
        const world = reach(path.join(SRC, 'preview', 'world.ts'));
        expect([...world.packages.keys()]).toContain('@platform/engine');
        expect(page.files.size).toBeGreaterThan(20);
    });
});
