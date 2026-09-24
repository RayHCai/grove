// The engine's own declarations, handed to the workbench's checker so a creator's file is typed
// against the real API rather than an editor's copy of it. Types only: nothing here is code the
// browser runs, and `@platform/engine` is never in this app's module graph.

/**
 * The closure a creator's program needs, and nothing above it.
 *
 * `engine/dist/index.d.ts` alone, deliberately — its `host` subpath is the composition roots a
 * server stands a game up with, which is not a creator's to see. The other four are what those
 * declarations reach: core is the API, math and project are what core names, and transport is the
 * one type project borrows.
 */
const sources: Record<string, string> = import.meta.glob(
    [
        '../../../../../packages/engine/dist/index.d.ts',
        '../../../../../packages/core/dist/**/*.d.ts',
        '../../../../../packages/math/dist/**/*.d.ts',
        '../../../../../packages/project/dist/**/*.d.ts',
        '../../../../../packages/transport/dist/**/*.d.ts',
    ],
    { query: '?raw', import: 'default', eager: true },
);

/** One declaration file as the workbench holds it. */
export interface TypeLib {
    content: string;
    /** Where the checker resolves it from; a package specifier lands on the path below. */
    filePath: string;
}

/** `…/packages/<name>/dist/<rest>` — the two halves a lib path is rebuilt from. */
const BUILT = /\/packages\/([^/]+)\/dist\/(.+\.d\.ts)$/u;

/**
 * The declarations as lib paths.
 *
 * Under `node_modules/@platform/<name>/`, with `dist/` dropped, because that is where node
 * resolution looks for a bare specifier: the checker reaches `@platform/engine` by finding
 * `index.d.ts` beside where the package would be, and each relative import inside it resolves the
 * same way it does on disk.
 */
export function engineTypeLibs(): TypeLib[] {
    const libs: TypeLib[] = [];
    for (const [path, content] of Object.entries(sources)) {
        const found = BUILT.exec(path.replaceAll('\\', '/'));
        if (found === null) continue;
        libs.push({ content, filePath: `file:///node_modules/@platform/${found[1]}/${found[2]}` });
    }
    return libs.toSorted((left, right) => left.filePath.localeCompare(right.filePath));
}
