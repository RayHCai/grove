// What Play does before anything runs: the workbench emits, the manifest is restamped from what
// the code now declares, and the result is checked the way a build would check it.
//
// The manifest is the one in the game (`project.json`), not a shape assembled here: the settings
// gear wrote it, so a local version is built from the same values a published one would be.

import { ProjectFormatError, validate } from '@platform/project';
import type { ProjectManifest } from '@platform/project';
import type { EmitResult, Problem } from '../editor/monaco';
import type { DraftFile } from '../workspace/files';
import { PROJECT_PATH, stamp } from './manifest';
import { preludeFor } from './prelude';
import { scanScripts } from './scripts';

/** A game as this page built it: the world, and the code that runs in it. */
export interface LocalVersion {
    project: ProjectManifest;
    /** The emitted modules by name, each carrying the import the editor hid from the creator. */
    modules: Record<string, string>;
    /** Whether anything in it reaches the engine, which a sandboxed run cannot stand up. */
    needsEngine: boolean;
}

export interface CompileResult {
    /** `null` when the game could not be built; the problems say why. */
    version: LocalVersion | null;
    problems: Problem[];
}

export interface CompileInput {
    files: readonly DraftFile[];
    project: ProjectManifest;
    /** The workbench's compiler, which is the one already holding every file. */
    emit: () => Promise<EmitResult>;
}

/** The sources a scan and a digest see: every text file the creator wrote, and no manifest. */
function sourcesOf(files: readonly DraftFile[]): { path: string; text: string }[] {
    return files.flatMap((file) =>
        file.text === undefined || file.path === PROJECT_PATH
            ? []
            : [{ path: file.path, text: file.text }],
    );
}

/** What a problem reads as when it is the project's rather than one line of one file's. */
function fault(path: string, message: string, severity: Problem['severity']): Problem {
    return { path, line: 1, column: 1, message, severity, syntactic: false };
}

/**
 * Compiles the game as it stands.
 *
 * A broken parse stops here: the JavaScript beside it cannot be trusted, and a manifest stamped
 * over it would claim classes the file no longer has. A wrong type does not — it still compiles to
 * something that runs, which is what the workbench reports as a warning.
 */
export async function compile({ files, project, emit }: CompileInput): Promise<CompileResult> {
    const { modules, problems } = await emit();
    if (problems.some((problem) => problem.syntactic)) return { version: null, problems };

    const sources = sourcesOf(files);
    const scan = scanScripts(sources);
    for (const found of scan.faults) {
        problems.push(fault(found.path, `${found.name}: ${found.message}`, 'warning'));
    }

    const stamped = await stamp(
        project,
        scan.modules,
        new Map(sources.map((source) => [source.path, source.text])),
    );

    try {
        validate(stamped);
    } catch (failure) {
        if (!(failure instanceof ProjectFormatError)) throw failure;
        problems.push(fault(PROJECT_PATH, failure.message, 'error'));
        return { version: null, problems };
    }

    const linked = withPreludes(modules, sources);
    return {
        version: {
            project: stamped,
            modules: linked.modules,
            // A declared script is an engine game whatever its modules import: the world is what
            // instantiates one, and nothing but the engine has a world.
            needsEngine: linked.needsEngine || stamped.scriptModules.length > 0,
        },
        problems,
    };
}

/**
 * The emitted modules with their imports put back.
 *
 * The editor showed the creator their code alone, so what the compiler emitted names the engine
 * without importing it. The import belongs above the module it serves, where a bundler, a browser
 * and a reader all look for it.
 */
function withPreludes(
    modules: Record<string, string>,
    sources: readonly { path: string; text: string }[],
): { modules: Record<string, string>; needsEngine: boolean } {
    const out: Record<string, string> = {};
    let needsEngine = false;

    for (const [name, code] of Object.entries(modules)) {
        const source = sources.find((each) => each.path.replace(/\.tsx?$/u, '.js') === name);
        const prelude = source === undefined ? '' : preludeFor(source.text);
        if (prelude !== '') needsEngine = true;
        out[name] = `${prelude}${code}`;
    }
    return { modules: out, needsEngine };
}

/** One line saying what was built, which is what the console pane prints on a successful build. */
export function summarize(version: LocalVersion): string {
    const scripts = version.project.scriptModules.flatMap((module) => module.scripts).length;
    const settings = version.project.settings;
    return (
        `Build succeeded: ${count(scripts, 'script')} in ${count(version.project.scriptModules.length, 'file')} — ` +
        `${String(settings.simRate)} Hz, up to ${count(settings.maxPlayers, 'player')}`
    );
}

function count(many: number, noun: string): string {
    return `${String(many)} ${noun}${many === 1 ? '' : 's'}`;
}
