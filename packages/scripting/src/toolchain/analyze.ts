// Locations come out of this pass and never off the runtime's `__location` static, because reading
// that would mean evaluating a creator's module to decide which chunk it belongs in.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { ScriptLocation } from '@platform/core';
import { BundleError } from '../errors.js';
import { asNodes, isNode, lineStarts, nodeName, parseModule } from './ast.js';
import type { Node } from './ast.js';

/** Modules whose `SyncedScript` / `ServerScript` / `ClientScript` are the roots of the hierarchy. */
export const DEFAULT_BASE_MODULES: readonly string[] = ['@platform/engine', '@platform/core'];

export interface AnalyzeOptions {
    /** The project's script sources — the `rootDir` its tsconfig emits from. */
    readonly srcDir: string;
    readonly baseModules?: readonly string[] | undefined;
}

/** One script class the project declares, at a location the analysis resolved. */
export interface ScriptClassInfo {
    /** POSIX, relative to `srcDir`. */
    readonly file: string;
    /** `file` without its extension — how the lowered chunk names the module. */
    readonly module: string;
    /** The binding name inside the module. */
    readonly local: string;
    /** The name it is exported under, `default` included; undefined for one kept private. */
    readonly export: string | undefined;
    readonly location: ScriptLocation;
}

/** One `SyncedScript` subclass, carrying everything the determinism pass walks it with. */
export interface SyncedClass {
    /** POSIX, relative to `srcDir`. */
    readonly file: string;
    /** The binding name inside the module. */
    readonly local: string;
    /** The class declaration or expression itself. */
    readonly node: Node;
    /** Offsets of each line start in the module, for turning a node position into line and column. */
    readonly lines: readonly number[];
    /** The module's top-level names; one shadows the denied global it shares a name with. */
    readonly bindings: readonly string[];
}

export interface Analysis {
    readonly modules: readonly Module[];
    /** Sorted by file, then by declaration name. */
    readonly scripts: readonly ScriptClassInfo[];
    /** What `checkDeterminism` takes: every synced class, abstract links in the chain included. */
    readonly synced: readonly SyncedClass[];
}

export interface ClassRecord {
    readonly local: string;
    /** The name it is exported under, `default` included; undefined for one kept private. */
    readonly export: string | undefined;
    readonly superName: string | undefined;
    /** An abstract or ambient class is a link in the chain, never a class an attach site takes. */
    readonly attachable: boolean;
    readonly node: Node;
}

export interface Module {
    readonly file: string;
    readonly module: string;
    readonly absPath: string;
    readonly lines: readonly number[];
    readonly bindings: ReadonlyMap<string, Binding>;
    readonly exports: ReadonlyMap<string, ExportTarget>;
    readonly starExports: readonly string[];
    readonly classes: readonly ClassRecord[];
}

export type Binding =
    | { readonly kind: 'class'; readonly klass: ClassRecord }
    | { readonly kind: 'import'; readonly source: string; readonly imported: string }
    | { readonly kind: 'other' };

export type ExportTarget =
    | { readonly kind: 'local'; readonly name: string }
    | { readonly kind: 'reexport'; readonly source: string; readonly imported: string };

/** Reads every `.ts` under `srcDir`, resolves the class hierarchy, and locates each script class. */
export function analyzeScripts(options: AnalyzeOptions): Analysis {
    const root = path.resolve(options.srcDir);
    const baseModules = new Set(options.baseModules ?? DEFAULT_BASE_MODULES);
    const modules = sourceFiles(root).map((absPath) => readModule(root, absPath));

    const byPath = new Map(modules.map((m) => [pathKey(m.absPath), m]));
    const resolver = new Resolver(byPath, baseModules);
    const scripts: ScriptClassInfo[] = [];
    const synced: SyncedClass[] = [];
    for (const mod of modules) {
        const bindings = [...mod.bindings.keys()];
        for (const klass of mod.classes) {
            const resolved = resolver.locateClass(mod, klass, new Set());
            if (resolved.kind !== 'location') continue;
            if (resolved.location === 'synced') {
                synced.push({
                    file: mod.file,
                    local: klass.local,
                    node: klass.node,
                    lines: mod.lines,
                    bindings,
                });
            }
            if (!klass.attachable) continue;
            scripts.push({
                file: mod.file,
                module: mod.module,
                local: klass.local,
                export: klass.export,
                location: resolved.location,
            });
        }
    }
    return {
        modules,
        scripts: scripts.toSorted(
            (a, b) => a.file.localeCompare(b.file) || a.local.localeCompare(b.local),
        ),
        synced,
    };
}

type Resolution =
    | { readonly kind: 'location'; readonly location: ScriptLocation }
    /** `BaseScript` — abstract, and it names no location, so nothing attachable stops here. */
    | { readonly kind: 'base' }
    | { readonly kind: 'unknown' };

const UNKNOWN: Resolution = { kind: 'unknown' };

const BASE_LOCATIONS: ReadonlyMap<string, ScriptLocation> = new Map([
    ['ServerScript', 'server'],
    ['ClientScript', 'client'],
    ['SyncedScript', 'synced'],
]);

class Resolver {
    readonly #byPath: ReadonlyMap<string, Module>;
    readonly #baseModules: ReadonlySet<string>;
    readonly #located = new Map<ClassRecord, Resolution>();

    constructor(byPath: ReadonlyMap<string, Module>, baseModules: ReadonlySet<string>) {
        this.#byPath = byPath;
        this.#baseModules = baseModules;
    }

    locateClass(mod: Module, klass: ClassRecord, seen: Set<string>): Resolution {
        const memo = this.#located.get(klass);
        if (memo) return memo;
        if (!klass.superName) return UNKNOWN;
        const resolved = this.#name(mod, klass.superName, seen);
        if (resolved.kind === 'location') this.#located.set(klass, resolved);
        return resolved;
    }

    #name(mod: Module, name: string, seen: Set<string>): Resolution {
        const key = `${mod.file}#${name}`;
        if (seen.has(key)) return UNKNOWN;
        seen.add(key);

        const binding = mod.bindings.get(name);
        if (!binding) return UNKNOWN;
        if (binding.kind === 'class') return this.locateClass(mod, binding.klass, seen);
        if (binding.kind !== 'import') return UNKNOWN;
        return this.#imported(mod, binding.source, binding.imported, seen);
    }

    #imported(mod: Module, source: string, imported: string, seen: Set<string>): Resolution {
        if (imported === '*') return UNKNOWN;
        if (!source.startsWith('.')) {
            if (!this.#baseModules.has(source)) return UNKNOWN;
            if (imported === 'BaseScript') return { kind: 'base' };
            const location = BASE_LOCATIONS.get(imported);
            return location ? { kind: 'location', location } : UNKNOWN;
        }
        const target = this.#module(mod, source);
        return target ? this.#export(target, imported, seen) : UNKNOWN;
    }

    #export(mod: Module, exported: string, seen: Set<string>): Resolution {
        const target = mod.exports.get(exported);
        if (target?.kind === 'local') return this.#name(mod, target.name, seen);
        if (target?.kind === 'reexport') {
            return this.#imported(mod, target.source, target.imported, seen);
        }
        for (const source of mod.starExports) {
            const via = this.#module(mod, source);
            if (!via) continue;
            const resolved = this.#export(via, exported, seen);
            if (resolved.kind !== 'unknown') return resolved;
        }
        return UNKNOWN;
    }

    // The project is TypeScript written for NodeNext, so a specifier names the `.js` tsc will emit.
    #module(from: Module, specifier: string): Module | undefined {
        const base = path.resolve(path.dirname(from.absPath), specifier);
        const stripped = base.replace(/\.(?:js|mjs|cjs)$/, '');
        for (const candidate of [`${stripped}.ts`, `${base}.ts`, path.join(stripped, 'index.ts')]) {
            const found = this.#byPath.get(pathKey(candidate));
            if (found) return found;
        }
        return undefined;
    }
}

function readModule(root: string, absPath: string): Module {
    const text = readFileSync(absPath, 'utf8');
    const file = path.relative(root, absPath).split(path.sep).join('/');
    const program = parseModule(text, file);
    const bindings = new Map<string, Binding>();
    const exports = new Map<string, ExportTarget>();
    const starExports: string[] = [];
    const classes: Draft<ClassRecord>[] = [];

    for (const statement of asNodes(program.body)) {
        collect(statement, { bindings, exports, starExports, classes });
    }
    // `export { Runner }` names a class declared earlier, so the export name is known only here.
    for (const [exported, target] of exports) {
        if (target.kind !== 'local') continue;
        const klass = classes.findLast((k) => k.local === target.name);
        if (klass && klass.export === undefined) klass.export = exported;
    }

    return {
        file,
        module: file.replace(/\.ts$/, ''),
        absPath,
        lines: lineStarts(text),
        bindings,
        exports,
        starExports,
        classes,
    };
}

// An export name is known only once the whole module is read, so records are filled in place.
type Draft<T> = { -readonly [K in keyof T]: T[K] };

interface Collector {
    readonly bindings: Map<string, Binding>;
    readonly exports: Map<string, ExportTarget>;
    readonly starExports: string[];
    readonly classes: Draft<ClassRecord>[];
}

function collect(statement: Node, into: Collector): void {
    switch (statement.type) {
        case 'ImportDeclaration': {
            const source = literalValue(statement.source);
            if (source === undefined) return;
            for (const specifier of asNodes(statement.specifiers)) {
                const local = nodeName(specifier.local);
                if (!local) continue;
                const imported =
                    specifier.type === 'ImportDefaultSpecifier'
                        ? 'default'
                        : specifier.type === 'ImportNamespaceSpecifier'
                          ? '*'
                          : (nodeName(specifier.imported) ??
                            literalValue(specifier.imported) ??
                            local);
                into.bindings.set(local, { kind: 'import', source, imported });
            }
            return;
        }
        case 'ClassDeclaration':
            declareClass(statement, undefined, into);
            return;
        case 'VariableDeclaration':
            declareVariables(statement, false, into);
            return;
        case 'FunctionDeclaration': {
            const name = nodeName(statement.id);
            if (name) into.bindings.set(name, { kind: 'other' });
            return;
        }
        case 'ExportNamedDeclaration': {
            const source = literalValue(statement.source);
            for (const specifier of asNodes(statement.specifiers)) {
                const exported = nodeName(specifier.exported) ?? literalValue(specifier.exported);
                const local = nodeName(specifier.local) ?? literalValue(specifier.local);
                if (!exported || !local) continue;
                into.exports.set(
                    exported,
                    source === undefined
                        ? { kind: 'local', name: local }
                        : { kind: 'reexport', source, imported: local },
                );
            }
            const declaration = statement.declaration;
            if (!isNode(declaration)) return;
            if (declaration.type === 'ClassDeclaration') {
                const name = nodeName(declaration.id);
                declareClass(declaration, name, into);
                if (name) into.exports.set(name, { kind: 'local', name });
            } else if (declaration.type === 'VariableDeclaration') {
                declareVariables(declaration, true, into);
            } else {
                const name = nodeName(declaration.id);
                if (name) {
                    into.bindings.set(name, { kind: 'other' });
                    into.exports.set(name, { kind: 'local', name });
                }
            }
            return;
        }
        case 'ExportDefaultDeclaration': {
            const declaration = statement.declaration;
            if (!isNode(declaration)) return;
            if (declaration.type === 'ClassDeclaration') {
                const local = nodeName(declaration.id) ?? 'default';
                declareClass(declaration, 'default', into);
                into.exports.set('default', { kind: 'local', name: local });
                return;
            }
            const name = nodeName(declaration);
            if (name) into.exports.set('default', { kind: 'local', name });
            return;
        }
        case 'ExportAllDeclaration': {
            const source = literalValue(statement.source);
            if (source !== undefined) into.starExports.push(source);
            return;
        }
        default:
    }
}

function declareClass(node: Node, exported: string | undefined, into: Collector): void {
    const local = nodeName(node.id) ?? exported;
    if (!local) return;
    const klass: Draft<ClassRecord> = {
        local,
        export: exported,
        superName: nodeName(node.superClass),
        attachable: node.abstract !== true && node.declare !== true,
        node,
    };
    into.bindings.set(local, { kind: 'class', klass });
    into.classes.push(klass);
}

// `const Runner = class extends SyncedScript {}` is a class the same way `class Runner` is.
function declareVariables(node: Node, exported: boolean, into: Collector): void {
    for (const declarator of asNodes(node.declarations)) {
        const name = nodeName(declarator.id);
        if (!name) continue;
        const init = declarator.init;
        if (isNode(init) && init.type === 'ClassExpression') {
            declareClass({ ...init, id: declarator.id } as Node, undefined, into);
        } else {
            into.bindings.set(name, { kind: 'other' });
        }
        if (exported) into.exports.set(name, { kind: 'local', name });
    }
}

function literalValue(value: unknown): string | undefined {
    return isNode(value) && value.type === 'Literal' && typeof value.value === 'string'
        ? value.value
        : undefined;
}

function sourceFiles(root: string): string[] {
    const found: string[] = [];
    walk(root);
    return found.toSorted();

    function walk(dir: string): void {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch (err) {
            throw new BundleError('source-unreadable', `${dir} could not be read`, { cause: err });
        }
        for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
            const child = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(child);
            else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) found.push(child);
        }
    }
}

// Case-folded, because the specifier carries the author's casing and the directory listing carries
// the disk's; `forceConsistentCasingInFileNames` is what refuses a project where the two differ.
function pathKey(absPath: string): string {
    return path.resolve(absPath).split(path.sep).join('/').toLowerCase();
}
