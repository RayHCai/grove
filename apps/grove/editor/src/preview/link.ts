// A compile's modules, evaluated inside the run's own document: each is given a url, and an import
// map names them all, so the browser's loader links the graph the way a bundle would, cycles too.

import { ENGINE_MODULE, ENGINE_VALUES, usesFreeName } from '@platform/scripting';
import type { ScriptEntry } from '@platform/scripting';
import type { ProjectManifest, ScriptId } from '@platform/project';

/** A module graph the run's document could not evaluate, named at the module that broke it. */
export class LinkError extends Error {
    override readonly name = 'LinkError';
}

/** Where a run's `console` goes: the editor's pane, not the devtools of a frame nobody opens. */
export interface ConsoleSink {
    log(...values: unknown[]): void;
    info(...values: unknown[]): void;
    warn(...values: unknown[]): void;
    error(...values: unknown[]): void;
}

/** What the generated host module exports: the engine for a world, and a console for any run. */
export interface LinkHost {
    engine?: Record<string, unknown> | undefined;
    console: ConsoleSink;
}

export interface LinkOptions {
    host: LinkHost;
    /** How a module's text becomes a url; a test hands in one that keeps the text readable. */
    urlFor?: ((text: string) => string) | undefined;
    /** How the map reaches the loader; a test keeps it rather than writing it into a document. */
    install?: ((imports: Readonly<Record<string, string>>) => void) | undefined;
    /** How a mapped specifier is evaluated; a test hands in one that needs no import map. */
    load?: ((specifier: string) => Promise<Record<string, unknown>>) | undefined;
}

/** One game's graph, mapped and ready: loading a module evaluates it and whatever it imports. */
export interface Linker {
    has(name: string): boolean;
    load(name: string): Promise<Record<string, unknown>>;
}

/** The prefix a game's own module is mapped under, which no specifier in its source can mean. */
export const MODULE_PREFIX = 'grove:';

/** Where the engine and the console are read from by every module that names either. */
export const HOST_MODULE = 'grove:host';

/** The global the host module reads its exports off; the document is this run's alone. */
const HOST_KEY = 'grove:preview:host';

/** Every static specifier, and every literal dynamic one, in the shapes an emitted module carries. */
const SPECIFIERS = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"\n]+)\2/gu;

/** `a/b/c.js` + `../d` → `a/d`, which is the loader's job for any url but a blob's. */
function resolveRelative(from: string, specifier: string): string {
    const parts = from.split('/').slice(0, -1);
    for (const step of specifier.split('/')) {
        if (step === '.' || step === '') continue;
        if (step === '..') parts.pop();
        else parts.push(step);
    }
    return parts.join('/');
}

function target(from: string, specifier: string, names: ReadonlySet<string>): string {
    const at = resolveRelative(from, specifier);
    const found = [at, `${at}.js`, `${at}/index.js`].find((candidate) => names.has(candidate));
    if (found === undefined) {
        throw new LinkError(`${from} imports ${specifier}, and nothing in this game is there`);
    }
    return found;
}

/** One module's text, its relative imports named the way the map names them. */
export function rewrite(name: string, text: string, names: ReadonlySet<string>): string {
    // A blob url has no path to resolve a relative specifier against, so each is named in full.
    const linked = text.replaceAll(
        SPECIFIERS,
        (whole, keyword: string, quote: string, specifier: string) =>
            specifier.startsWith('.')
                ? `${keyword}${quote}${MODULE_PREFIX}${target(name, specifier, names)}${quote}`
                : whole,
    );
    // The declarations a creator writes against promise a `console` that reaches the editor.
    return usesFreeName(text, 'console')
        ? `import { console } from ${JSON.stringify(HOST_MODULE)};\n${linked}`
        : linked;
}

function hostSource(engine: boolean): string {
    const host = `globalThis[${JSON.stringify(HOST_KEY)}]`;
    const values = engine ? `export const { ${ENGINE_VALUES.join(', ')} } = ${host}.engine;\n` : '';
    return `${values}export const console = ${host}.console;\n`;
}

function blobUrl(text: string): string {
    return URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
}

function installImportMap(imports: Readonly<Record<string, string>>): void {
    const map = document.createElement('script');
    map.type = 'importmap';
    map.textContent = JSON.stringify({ imports });
    document.head.append(map);
}

async function nativeLoad(specifier: string): Promise<Record<string, unknown>> {
    // Vite cannot analyse a specifier only the import map written a moment ago resolves.
    return import(/* @vite-ignore */ specifier) as Promise<Record<string, unknown>>;
}

// The engine is handed in rather than evaluated again, so every `ServerScript` a creator extended
// is the same class the world checks against.
export function link(modules: Readonly<Record<string, string>>, options: LinkOptions): Linker {
    const { host, urlFor = blobUrl, install = installImportMap, load = nativeLoad } = options;
    (globalThis as Record<string, unknown>)[HOST_KEY] = host;

    const names = new Set(Object.keys(modules));
    const hostUrl = urlFor(hostSource(host.engine !== undefined));
    const imports: Record<string, string> = { [HOST_MODULE]: hostUrl };
    if (host.engine !== undefined) imports[ENGINE_MODULE] = hostUrl;
    for (const [name, text] of Object.entries(modules)) {
        imports[`${MODULE_PREFIX}${name}`] = urlFor(rewrite(name, text, names));
    }
    install(imports);

    return {
        has: (name) => names.has(name),
        load: async (name) => {
            if (!names.has(name)) throw new LinkError(`the compiler emitted no ${name}`);
            try {
                return await load(`${MODULE_PREFIX}${name}`);
            } catch (failure) {
                throw failure instanceof LinkError
                    ? failure
                    : new LinkError(failure instanceof Error ? failure.message : String(failure));
            }
        },
    };
}

/** A `.ts` path as the emitter names the module it produced. */
export function emittedName(path: string): string {
    return path.replace(/\.tsx?$/u, '.js');
}

/** The manifest's declarations, each married to the class its evaluated module exported. */
export async function entriesOf(
    project: ProjectManifest,
    linker: Linker,
): Promise<ScriptEntry<ScriptId>[]> {
    const entries: ScriptEntry<ScriptId>[] = [];
    for (const module of project.scriptModules) {
        const name = emittedName(module.path);
        if (!linker.has(name)) {
            throw new LinkError(
                `${module.path} declares scripts, and the compiler emitted no ${name}`,
            );
        }
        // One at a time, so a graph evaluates in the same order on every run.
        // oxlint-disable-next-line no-await-in-loop
        const namespace = await linker.load(name);
        for (const script of module.scripts) {
            const ctor = namespace[script.export];
            if (typeof ctor !== 'function') {
                throw new LinkError(
                    `${module.path} does not export a class called ${script.export}`,
                );
            }
            entries.push({
                id: script.id,
                location: script.location,
                ctor: ctor as ScriptEntry<ScriptId>['ctor'],
            });
        }
    }
    return entries;
}
