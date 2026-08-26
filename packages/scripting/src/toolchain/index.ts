// @platform/scripting/toolchain
// The build-time half: it reads a project's sources, refuses the ones a SyncedScript may not run,
// lowers with tsc and links one chunk per side. Node only — never import this from a browser graph.

import { BundleError } from '../errors.js';
import type { Analysis, ScriptClassInfo } from './analyze.js';
import { analyzeScripts } from './analyze.js';
import { assertDeterminism } from './check.js';
import { lowerScripts } from './lower.js';
import type { ScriptBundle, ScriptDeclaration } from './link.js';
import { linkChunks } from './link.js';

export type { AnalyzeOptions, Analysis, ScriptClassInfo, Module, ClassRecord } from './analyze.js';
export { analyzeScripts, DEFAULT_BASE_MODULES } from './analyze.js';
export { checkDeterminism, assertDeterminism } from './check.js';
export type { LowerOptions } from './lower.js';
export { lowerScripts } from './lower.js';
export type { LinkOptions, ScriptBundle, ScriptDeclaration, SideChunk } from './link.js';
export { linkChunks } from './link.js';
export type { Diagnostic } from '../errors.js';
export { BundleError, DeterminismError, formatDiagnostic } from '../errors.js';

/** One class the project wants stamped, named the way the manifest names it. */
export interface ScriptRef<Id extends string = string> {
    readonly id: Id;
    /** POSIX, relative to `srcDir`, without an extension. */
    readonly module: string;
    /** The name the module exports it under; `default` for a default export. */
    readonly export: string;
}

export interface BuildOptions<Id extends string = string> {
    /** The creator project's tsconfig, whose `rootDir` must be `srcDir`. */
    readonly tsconfig: string;
    readonly srcDir: string;
    /** Where the lowered JS lands, between the two stages. */
    readonly loweredDir: string;
    /** Where the two side chunks land. */
    readonly outDir: string;
    /** The ids to stamp. Omitted, every exported script class is taken as `<module>#<Export>`. */
    readonly scripts?: readonly ScriptRef<Id>[] | undefined;
    readonly baseModules?: readonly string[] | undefined;
}

/**
 * The whole pipeline: analyse, refuse, lower, link.
 *
 * The refusal comes before the compiler runs, so a determinism diagnostic points at the creator's
 * own line rather than at whatever the lowering turned it into.
 */
export async function buildScriptBundle<Id extends string = string>(
    options: BuildOptions<Id>,
): Promise<ScriptBundle<Id>> {
    const analysis = analyzeScripts({
        srcDir: options.srcDir,
        baseModules: options.baseModules,
    });
    assertDeterminism(analysis);

    const scripts = declarationsFor(analysis, options.scripts);
    lowerScripts({ tsconfig: options.tsconfig, outDir: options.loweredDir });
    return linkChunks({ loweredDir: options.loweredDir, outDir: options.outDir, scripts });
}

function declarationsFor<Id extends string>(
    analysis: Analysis,
    refs: readonly ScriptRef<Id>[] | undefined,
): ScriptDeclaration<Id>[] {
    const declarations = refs
        ? refs.map((ref) => ({ ...ref, location: locate(analysis, ref).location }))
        : analysis.scripts
              .filter(
                  (script): script is ScriptClassInfo & { exported: string } =>
                      script.exported !== undefined,
              )
              .map((script) => ({
                  id: `${script.module}#${script.exported}` as Id,
                  module: script.module,
                  export: script.exported,
                  location: script.location,
              }));

    const seen = new Set<string>();
    for (const declaration of declarations) {
        if (seen.has(declaration.id)) {
            throw new BundleError(`two script classes claim the id "${declaration.id}"`);
        }
        seen.add(declaration.id);
    }
    return declarations;
}

function locate<Id extends string>(analysis: Analysis, ref: ScriptRef<Id>): ScriptClassInfo {
    const found = analysis.scripts.find(
        (script) => script.module === ref.module && script.exported === ref.export,
    );
    if (!found) {
        throw new BundleError(
            `${ref.module} exports no script class named ${ref.export} — a script class extends ServerScript, ClientScript or SyncedScript`,
        );
    }
    return found;
}
