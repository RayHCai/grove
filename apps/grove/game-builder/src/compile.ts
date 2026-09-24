// Node only, and the one place in this service that evaluates nothing a creator wrote: the
// determinism pass reads the source, tsc checks it, and both refuse before a bundler is started.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { migrate, validate } from '@platform/project';
import type { ProjectManifest, ScriptId } from '@platform/project';
import { AMBIENT_DTS, preludeFor, typePreludeFor } from '@platform/scripting';
import { BundleError, DeterminismError, buildScriptBundle } from '@platform/scripting/toolchain';
import type { ScriptRef } from '@platform/scripting/toolchain';
import type { BuildDiagnostic, ContentHash } from '@grove/api-contract';

/** Where a game's manifest sits in its workspace; the editor writes it and a build reads it. */
const PROJECT_PATH = 'project.json';

/**
 * Where one build's tree is put together.
 *
 * Under this package rather than the system temp directory, and deliberately: `tsc` and the two
 * bundlers resolve `@platform/*` by walking up from the file that imports it, so a creator's
 * module has to sit somewhere those walks reach this service's own `node_modules`.
 */
const WORK_ROOT = fileURLToPath(new URL('../.builds', import.meta.url));

/** This service's own resolution root, so a bundler started elsewhere still finds the engine. */
const MODULE_ROOT = fileURLToPath(new URL('../node_modules', import.meta.url));

/** What the editor's own compiler is set to, restated: what typechecks on screen must build here. */
const TSCONFIG = {
    compilerOptions: {
        // ES2022 and not ESNext, because tsc emits a standard decorator verbatim for a target that
        // claims to have them — and an unlowered `@onStart` is a chunk whose metadata is empty.
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        // No DOM: a game is not a page, and two engine names — `Storage` and `Animation` — would
        // collide outright with that library's.
        lib: ['ES2023'],
        strict: true,
        skipLibCheck: true,
        // A creator's project declares no ambient types, and pulling this box's would let a game
        // compile against `process` on a machine that has one.
        types: [],
        rootDir: 'game',
        declaration: false,
        sourceMap: false,
    },
    include: ['game/**/*.ts'],
};

/** What one build produced, before anything has been told where it will live. */
export interface BuildOutput {
    project: ProjectManifest;
    /** The module a joining browser fetches and evaluates. */
    client: Buffer;
    /** The classic script a session's isolate evaluates. */
    server: Buffer;
    /** What a handshake compares: the synced classes linked on their own. */
    syncedHash: ContentHash;
}

/**
 * `rejected` is the creator's source, which is settled as failed and never retried. `unavailable`
 * is this box or its toolchain, which is left for another box to claim.
 */
export type Compiled =
    | { outcome: 'compiled'; output: BuildOutput }
    | { outcome: 'rejected'; message: string; diagnostics: BuildDiagnostic[] }
    | { outcome: 'unavailable'; message: string };

/** One source file as the manifest named it and the bucket answered for it. */
export interface SourceFile {
    path: string;
    text: string;
}

/**
 * Analyses, refuses, compiles and links one revision's source.
 *
 * The order is the toolchain's and is not this service's to change: the determinism pass runs
 * before `tsc` so a refusal points at the creator's own line, and the linker runs after it so it
 * only ever sees lowered output.
 */
export async function compile(id: string, sources: readonly SourceFile[]): Promise<Compiled> {
    const work = path.join(WORK_ROOT, id);
    try {
        return await run(work, sources);
    } catch (error) {
        // Anything the two passes below did not name is this box: a full disk, a killed compiler,
        // a bundler that fell over. Settling a creator's build as failed over one would tell them
        // their game is broken when it is not.
        return { outcome: 'unavailable', message: messageOf(error) };
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

async function run(work: string, sources: readonly SourceFile[]): Promise<Compiled> {
    const gameDir = path.join(work, 'game');
    rmSync(work, { recursive: true, force: true });
    for (const source of sources) {
        const target = path.join(gameDir, source.path);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, prefixed(source), 'utf8');
    }

    const project = projectOf(sources);
    if (project === undefined) {
        return {
            outcome: 'rejected',
            message: `${PROJECT_PATH} is missing or is not a project this build can read`,
            diagnostics: [],
        };
    }

    // Beside the creator's files rather than above them, so it is inside the source root `tsc`
    // emits from and every module in the project sees it.
    writeFileSync(path.join(gameDir, 'grove-ambient.d.ts'), AMBIENT_DTS, 'utf8');

    const tsconfig = path.join(work, 'tsconfig.json');
    writeFileSync(tsconfig, JSON.stringify(TSCONFIG, null, 4), 'utf8');

    const chunks = path.join(work, 'chunks');
    let bundle;
    try {
        bundle = await buildScriptBundle<ScriptId>({
            tsconfig,
            srcDir: gameDir,
            loweredDir: path.join(work, 'lowered'),
            outDir: chunks,
            // The manifest's ids rather than the ones the analysis would invent, because an
            // attachment names a script by the id the editor stamped and a chunk carrying a
            // different one resolves to nothing at boot.
            scripts: declaredScripts(project),
        });
    } catch (error) {
        return refusal(error, gameDir);
    }

    // The client first, so the id every joiner is checked against is the digest of the bytes a
    // browser will actually fetch rather than of the chunk that went into them.
    const client = await link({
        entry: writeEntry(chunks, 'entry-client.js', clientEntry(bundle.client.fileName)),
        outFile: path.join(work, 'client.js'),
        format: 'esm',
        platform: 'browser',
    });
    const server = await link({
        entry: writeEntry(chunks, 'entry-server.js', serverEntry(bundle.server.fileName, project)),
        outFile: path.join(work, 'server.js'),
        // An IIFE, so the whole thing is one classic script: a session's isolate has no module
        // loader and no event loop, so neither an export nor a top-level await can be answered.
        format: 'iife',
        platform: 'neutral',
    });

    return {
        outcome: 'compiled',
        output: { project, client, server, syncedHash: bundle.syncedHash as ContentHash },
    };
}

/**
 * One source as a compiler has to see it.
 *
 * A creator writes no imports — every engine name is a bare global in the workbench — so the
 * import is put back here, from the same list the editor's own compile uses.
 *
 * It shares the file's first line rather than taking one of its own, because every position this
 * build reports is read off the file it handed the compiler: a diagnostic a line out is one a
 * creator cannot follow back to the code they wrote.
 */
function prefixed(source: SourceFile): string {
    if (!/\.tsx?$/u.test(source.path)) return source.text;
    const prelude = `${preludeFor(source.text)}${typePreludeFor(source.text)}`
        .replaceAll('\n', ' ')
        .trim();
    return prelude === '' ? source.text : `${prelude} ${source.text}`;
}

/** The manifest the game is authored as, migrated forward and checked before anything reads it. */
function projectOf(sources: readonly SourceFile[]): ProjectManifest | undefined {
    const held = sources.find((source) => source.path === PROJECT_PATH);
    if (held === undefined) return undefined;
    try {
        const parsed: unknown = JSON.parse(held.text);
        // Migrated before it is checked, because a file below this build's format is moved forward
        // and only one above it is refused — a saved game cannot be told to update itself.
        return validate(migrate(parsed));
    } catch {
        return undefined;
    }
}

/** Every script class the manifest declares, as the toolchain names one. */
function declaredScripts(project: ProjectManifest): ScriptRef<ScriptId>[] {
    return project.scriptModules.flatMap((module) =>
        module.scripts.map((declared) => ({
            id: declared.id,
            module: module.path.replace(/\.tsx?$/u, ''),
            export: declared.export,
        })),
    );
}

function writeEntry(dir: string, name: string, source: string): string {
    const file = path.join(dir, name);
    writeFileSync(file, source, 'utf8');
    return file;
}

/** The browser's half: the chunk's two exports and nothing added to them. */
function clientEntry(chunk: string): string {
    return `export { side, scripts } from './${chunk}';\n`;
}

/**
 * The session's half: the world, built from the manifest the save froze.
 *
 * The manifest is embedded rather than fetched, because an isolate has no way to fetch anything.
 * What the host's own config still decides is where a joiner gets the client half and what its
 * bytes have to hash to — the one pair that cannot be known until the client half is stored.
 */
function serverEntry(chunk: string, project: ProjectManifest): string {
    return `import { createSim } from '@platform/engine/host';
import { ScriptRegistry } from '@platform/scripting';
import { installIsolateEntry } from '@platform/sim';
import { scripts } from './${chunk}';

const project = ${JSON.stringify(project)};
const registry = ScriptRegistry.from(scripts);

installIsolateEntry((config) =>
    createSim(project, {
        scripts: registry,
        bundle: {
            url: config?.project?.bundleUrl ?? '',
            hash: config?.project?.bundleHash ?? '',
        },
    }),
);
`;
}

interface LinkOptions {
    entry: string;
    outFile: string;
    format: 'esm' | 'iife';
    platform: 'browser' | 'neutral';
}

/**
 * Rolls one half and everything it imports into a single file.
 *
 * Nothing is left external. The two places these bytes are evaluated — a blob URL in a browser and
 * an isolate with no loader — can neither of them answer a bare specifier, and core's metadata
 * crosses a second copy of itself unharmed because every table it keeps is keyed by a registered
 * symbol.
 */
async function link(options: LinkOptions): Promise<Buffer> {
    const built = await esbuild({
        entryPoints: [options.entry],
        bundle: true,
        write: false,
        format: options.format,
        platform: options.platform,
        target: 'es2022',
        outfile: options.outFile,
        logLevel: 'silent',
        // This service's own modules, so a work tree outside the package still resolves the engine.
        nodePaths: [MODULE_ROOT],
    });

    const output = built.outputFiles?.[0];
    if (output === undefined) throw new Error('the bundler produced no output');
    return Buffer.from(output.contents);
}

/** What a refusal from the toolchain settles as, and which of the two kinds of failure it is. */
function refusal(error: unknown, gameDir: string): Compiled {
    if (error instanceof DeterminismError) {
        return {
            outcome: 'rejected',
            message: error.message,
            diagnostics: error.diagnostics.map((found) => ({
                severity: 'error',
                file: found.file,
                line: found.line,
                column: found.column,
                message: `${found.klass} reads ${found.found}. Use ${found.use}; ${found.because}.`,
            })),
        };
    }

    if (error instanceof BundleError) {
        // A compiler that could not be started is this box missing a toolchain, not a game that
        // does not compile — the one BundleError that must never fail a creator's build.
        if (error.code === 'tsc-unavailable') {
            return { outcome: 'unavailable', message: error.message };
        }
        return {
            outcome: 'rejected',
            message: error.message,
            diagnostics: error.code === 'tsc-failed' ? typeErrors(error.message, gameDir) : [],
        };
    }
    throw error;
}

/** `game/src/player.ts(12,5): error TS2322: ...`, which is what tsc prints and an editor gutters. */
const TS_ERROR = /^(.+?)\((\d+),(\d+)\): (error|warning) TS\d+: (.+)$/u;

/** The compiler's own lines, positioned; anything it printed in another shape is passed over. */
function typeErrors(output: string, gameDir: string): BuildDiagnostic[] {
    const found: BuildDiagnostic[] = [];
    for (const line of output.split('\n')) {
        const parts = TS_ERROR.exec(line.trim());
        if (parts === null) continue;
        found.push({
            severity: parts[4] === 'warning' ? 'warning' : 'error',
            // Relative to the source root, so a message reads as the path the creator typed rather
            // than as wherever this box happened to unpack their game.
            file: path.relative(gameDir, path.resolve(parts[1] ?? '')).replaceAll('\\', '/'),
            line: Number(parts[2]),
            column: Number(parts[3]),
            message: parts[5] ?? '',
        });
    }
    return found;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
