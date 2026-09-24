// What stands between a compile and a world: the emitted modules are text, and a world instantiates
// classes. This evaluates that text in this page and answers with the classes the manifest names.
//
// A deployed game is linked by `@platform/scripting`'s toolchain, which has rolldown and a file
// system. Neither is here, so the module graph is given urls of its own and handed to the browser's
// own loader — the same evaluation, one module at a time instead of one chunk.

import type { ScriptId } from '@platform/project';
import type { ScriptEntry } from '@platform/scripting';
import type { LocalVersion } from './compile';
import { ENGINE_MODULE, ENGINE_VALUES, usesFreeName } from './prelude';

/** What a run writes to, which is the editor's console pane rather than the browser's. */
export interface ConsoleSink {
    log(...values: unknown[]): void;
    info(...values: unknown[]): void;
    warn(...values: unknown[]): void;
    error(...values: unknown[]): void;
}

export interface LinkOptions {
    /** The engine as this page already holds it; the creator's imports are pointed at exactly it. */
    engine: Record<string, unknown>;
    /** Where the creator's `console` goes. Without one it is the page's, which nobody is reading. */
    console: ConsoleSink;
    /** How a module's text becomes something `load` can take; a test hands in one node can read. */
    urlFor?: (text: string) => string;
    load?: (url: string) => Promise<Record<string, unknown>>;
}

/** A game's classes, live in this page, and the urls holding them up. */
export interface LinkedGame {
    scripts: ScriptEntry<ScriptId>[];
    /** Releases the urls. The classes outlive it — a module graph is held by what imported it. */
    dispose: () => void;
}

/** A module graph this page could not evaluate, named at the module that broke it. */
export class LinkError extends Error {
    override readonly name = 'LinkError';
}

/**
 * The handoff a generated module reads the engine back off.
 *
 * A module given a url of its own is fetched by the loader, not resolved through this page's
 * bundle, so it cannot reach an import — and two of the same engine would be two sets of base
 * classes, of which the world would recognise one. A key per link, deleted once the graph has
 * evaluated, so nothing of a finished run is left standing on the global.
 */
const HANDOFF = 'grove:editor:preview';

let links = 0;

/**
 * The module every hidden `@platform/engine` import is pointed at.
 *
 * `console` rides along because the declarations a creator writes against say their logging reaches
 * the editor, and a `console` left as the page's would reach the devtools drawer instead.
 */
function shimSource(key: string): string {
    const handoff = `globalThis[${JSON.stringify(key)}]`;
    return (
        `const handoff = ${handoff};\n` +
        `export const { ${ENGINE_VALUES.join(', ')} } = handoff.engine;\n` +
        `export const console = handoff.console;\n`
    );
}

/** A `.ts` path as the emitter names the module it produced. */
function emittedName(path: string): string {
    return path.replace(/\.tsx?$/u, '.js');
}

/** `a/b/c.js` + `../d` → `a/d`; the loader's job, done here because there is no loader yet. */
function resolveRelative(from: string, specifier: string): string {
    const parts = from.split('/').slice(0, -1);
    for (const step of specifier.split('/')) {
        if (step === '.' || step === '') continue;
        if (step === '..') parts.pop();
        else parts.push(step);
    }
    return parts.join('/');
}

/** Which module a specifier names, or `undefined` for one this graph does not hold. */
function resolve(from: string, specifier: string, names: ReadonlySet<string>): string | undefined {
    if (!specifier.startsWith('.')) return undefined;
    const at = resolveRelative(from, specifier);
    return [at, `${at}.js`, `${at}/index.js`].find((candidate) => names.has(candidate));
}

/** Every static specifier in a module, in the two shapes an emitted module can carry them. */
const SPECIFIERS = /\b(?:from|import)\s*(['"])([^'"\n]+)\1/gu;

/** The modules one module imports, which is what decides the order they are given urls in. */
function importsOf(name: string, text: string, names: ReadonlySet<string>): string[] {
    const found = new Set<string>();
    for (const [, , specifier = ''] of text.matchAll(SPECIFIERS)) {
        const target = resolve(name, specifier, names);
        if (target !== undefined) found.add(target);
    }
    return [...found];
}

/**
 * The modules in an order where nothing is given a url before what it imports has one.
 *
 * A blob's contents are fixed when it is made, so a module's text has to name its dependencies'
 * urls — which means they have to exist first. A circle has no such order, and is refused rather
 * than half-linked.
 */
function order(modules: ReadonlyMap<string, string>): string[] {
    const names = new Set(modules.keys());
    const sorted: string[] = [];
    const done = new Set<string>();
    const open = new Set<string>();

    const visit = (name: string): void => {
        if (done.has(name)) return;
        if (open.has(name)) {
            throw new LinkError(`${name} imports itself, around a circle this page cannot link`);
        }
        open.add(name);
        for (const next of importsOf(name, modules.get(name) ?? '', names)) visit(next);
        open.delete(name);
        done.add(name);
        sorted.push(name);
    };

    for (const name of [...names].toSorted()) visit(name);
    return sorted;
}

/** One module's text with every specifier it carries pointed at a url the loader can fetch. */
function rewrite(
    name: string,
    text: string,
    engineUrl: string,
    urls: ReadonlyMap<string, string>,
): string {
    const names = new Set(urls.keys());
    const linked = text.replaceAll(SPECIFIERS, (whole, quote: string, specifier: string) => {
        if (specifier === ENGINE_MODULE) return whole.replace(specifier, engineUrl);
        const target = resolve(name, specifier, names);
        // A specifier naming nothing this graph holds is left as it is, so the loader refuses it
        // by name rather than this quietly pointing it somewhere.
        return target === undefined ? whole : whole.replace(specifier, urls.get(target) ?? '');
    });
    // The declarations a creator writes against give them a `console`; this is where that name
    // becomes the editor's rather than the page's.
    return usesFreeName(text, 'console')
        ? `import { console } from ${JSON.stringify(engineUrl)};\n${linked}`
        : linked;
}

function blobUrl(text: string): string {
    return URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
}

function nativeLoad(url: string): Promise<Record<string, unknown>> {
    // Vite cannot analyse a specifier it will never see, and does not need to: the module behind
    // this url was written a moment ago by the line above.
    return import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>;
}

/**
 * Evaluates a compiled game in this page and answers with the classes a world attaches.
 *
 * The engine is not evaluated again: it is handed in, so every `ServerScript` a creator extended is
 * the same class the world checks against. Which is also why this cannot run a game the page has
 * not already imported the engine for.
 */
export async function linkVersion(
    version: LocalVersion,
    { engine, console: sink, urlFor = blobUrl, load = nativeLoad }: LinkOptions,
): Promise<LinkedGame> {
    const key = `${HANDOFF}:${String((links += 1))}`;
    const modules = new Map(Object.entries(version.modules));
    const urls = new Map<string, string>();
    const made: string[] = [];
    const release = (): void => {
        for (const url of made) {
            if (url.startsWith('blob:')) URL.revokeObjectURL(url);
        }
    };

    const engineUrl = urlFor(shimSource(key));
    made.push(engineUrl);
    (globalThis as Record<string, unknown>)[key] = { engine, console: sink };

    try {
        const namespaces = new Map<string, Record<string, unknown>>();
        for (const name of order(modules)) {
            const url = urlFor(rewrite(name, modules.get(name) ?? '', engineUrl, urls));
            made.push(url);
            urls.set(name, url);
            // In order, and one at a time: a module is evaluated before anything importing it is
            // given a url, which is the whole reason the order above exists.
            // oxlint-disable-next-line no-await-in-loop
            namespaces.set(name, await load(url));
        }
        return { scripts: entriesOf(version, namespaces), dispose: release };
    } catch (failure) {
        release();
        throw failure instanceof LinkError
            ? failure
            : new LinkError(failure instanceof Error ? failure.message : String(failure));
    } finally {
        delete (globalThis as Record<string, unknown>)[key];
    }
}

/** The manifest's declarations, each married to the class the evaluated module exported for it. */
function entriesOf(
    version: LocalVersion,
    namespaces: ReadonlyMap<string, Record<string, unknown>>,
): ScriptEntry<ScriptId>[] {
    const entries: ScriptEntry<ScriptId>[] = [];
    for (const module of version.project.scriptModules) {
        const name = emittedName(module.path);
        const namespace = namespaces.get(name);
        if (namespace === undefined) {
            throw new LinkError(
                `${module.path} declares scripts, and the compiler emitted no ${name}`,
            );
        }
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
