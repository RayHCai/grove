// The sandbox a run plays in, built beside the editor: a document per kind of run and the one
// classic script it loads, since a module script fetched from an origin of its own needs CORS.

import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import type { Plugin, ResolvedConfig } from 'vite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const ENTRIES = { plain: 'src/preview/plain.ts', world: 'src/preview/world.ts' } as const;
type Mode = keyof typeof ENTRIES;
const MODES = Object.keys(ENTRIES) as Mode[];

const VIRTUAL = 'virtual:grove-preview';
const RESOLVED = `\0${VIRTUAL}`;

/** Where a dev server answers for what a build emits, under a prefix no app route can take. */
const DEV_PREFIX = '/@grove-preview/';

/** The layout every run's document carries, fixed so its hash is what the policy admits. */
const STYLE =
    'html,body{margin:0;height:100%;overflow:hidden}' +
    'body{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}' +
    '.grove-stage{position:absolute;inset:0;overflow:hidden}' +
    '.grove-stage canvas{display:block;width:100%;height:100%}';

/** A path as both rolldown and the watcher can be compared by, on a filesystem that ignores case. */
function sameFile(file: string): string {
    const resolved = path.resolve(file).replaceAll('\\', '/');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function digest(text: string, encoding: 'base64' | 'hex'): string {
    return createHash('sha256').update(text).digest(encoding);
}

/** What a run's document may do: run its own script and the game's blobs, and reach no network. */
export function previewPolicy(): string {
    return [
        "default-src 'none'",
        // Inline for the import map naming the game's modules; the page is the creator's code anyway.
        "script-src 'self' blob: 'unsafe-inline'",
        `style-src 'sha256-${digest(STYLE, 'base64')}'`,
        "img-src 'self' blob: data:",
        "media-src 'self' blob: data:",
        "font-src 'self' blob: data:",
        // Nothing at all over the network: the editor's API above all, but every other host too.
        'connect-src blob: data:',
        'worker-src blob:',
        "base-uri 'none'",
        "form-action 'none'",
    ].join('; ');
}

/** One run's document: the policy, the layout, and the classic script that holds the rest. */
export function previewDocument(script: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${previewPolicy()}">
<title>Grove preview</title>
<style>${STYLE}</style>
</head>
<body>
<script src="${script}"></script>
</body>
</html>
`;
}

/** One kind of run's whole runtime as a single classic script: no import a frame would fetch. */
async function bundle(mode: Mode, production: boolean): Promise<{ code: string; files: string[] }> {
    const built = await build({
        configFile: false,
        root: ROOT,
        mode: production ? 'production' : 'development',
        logLevel: 'warn',
        publicDir: false,
        define: {
            'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
        },
        build: {
            write: false,
            copyPublicDir: false,
            emptyOutDir: false,
            minify: production,
            sourcemap: production ? false : 'inline',
            reportCompressedSize: false,
            modulePreload: false,
            // One chunk is the point: a frame of its own cannot fetch a second.
            chunkSizeWarningLimit: 16_384,
            rolldownOptions: {
                input: path.join(ROOT, ENTRIES[mode]),
                // Only Vite's preload helper reads it, and only for a dynamic import with deps to preload.
                transform: { define: { 'import.meta': '{}' } },
                output: { format: 'iife', codeSplitting: false, entryFileNames: `${mode}.js` },
            },
        },
    });
    const outputs = Array.isArray(built) ? built : [built];
    for (const output of outputs) {
        if (!('output' in output)) continue;
        for (const file of output.output) {
            if (file.type === 'chunk' && file.isEntry) {
                const files = file.moduleIds.filter((id) => path.isAbsolute(id));
                return { code: file.code, files: files.map(sameFile) };
            }
        }
    }
    throw new Error(`the ${mode} preview runtime built no entry chunk`);
}

/** The editor page's own policy: its scripts alone, so nothing a creator writes can join them. */
export function editorPolicy(html: string, apiUrl: string | undefined): string {
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map(
        ([, script = '']) => `'sha256-${digest(script, 'base64')}'`,
    );
    const api = apiUrl === undefined ? undefined : new URL(apiUrl);
    return [
        "default-src 'self'",
        ['script-src', "'self'", ...inline].join(' '),
        // Monaco writes its own style elements.
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        "img-src 'self' data: blob:",
        // The API, and a presigned upload to a bucket this build is never told.
        [
            'connect-src',
            "'self'",
            'https:',
            ...(api?.protocol === 'http:' ? [api.origin] : []),
        ].join(' '),
        "worker-src 'self'",
        "frame-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
    ].join('; ');
}

/** Builds and serves the sandbox, and gives a built editor page its policy. */
export function previewRuntime(): Plugin {
    let config: ResolvedConfig;
    const dev = new Map<Mode, Promise<{ code: string; files: string[] }>>();

    return {
        name: 'grove-preview-runtime',

        configResolved(resolved) {
            config = resolved;
        },

        resolveId: (id) => (id === VIRTUAL ? RESOLVED : undefined),

        async load(id) {
            if (id !== RESOLVED) return undefined;
            const documents: Record<string, string> = {};
            for (const mode of MODES) {
                if (config.command === 'serve') {
                    documents[mode] = `${DEV_PREFIX}${mode}.html`;
                    continue;
                }
                // One at a time: each is a whole build, and two at once only race for the same cores.
                // oxlint-disable-next-line no-await-in-loop
                const { code } = await bundle(mode, true);
                const script = `assets/preview-${mode}-${digest(code, 'hex').slice(0, 10)}.js`;
                this.emitFile({ type: 'asset', fileName: script, source: code });
                const html = previewDocument(`${config.base}${script}`);
                const page = `preview-${mode}-${digest(html, 'hex').slice(0, 10)}.html`;
                this.emitFile({ type: 'asset', fileName: page, source: html });
                documents[mode] = `${config.base}${page}`;
            }
            return `export const PREVIEW_DOCUMENTS = ${JSON.stringify(documents)};`;
        },

        configureServer(server) {
            server.watcher.on('change', (changed) => {
                const file = sameFile(changed);
                for (const [mode, built] of dev) {
                    void built
                        .then(({ files }) => {
                            if (files.includes(file)) dev.delete(mode);
                        })
                        .catch(() => dev.delete(mode));
                }
            });
            server.middlewares.use((request, response, next) => {
                const asked = new URL(request.url ?? '/', 'http://localhost').pathname;
                const found = /^\/@grove-preview\/(plain|world)\.(html|js)$/u.exec(asked);
                if (found === null) {
                    next();
                    return;
                }
                const mode = found[1] as Mode;
                response.setHeader('cache-control', 'no-store');
                if (found[2] === 'html') {
                    response.setHeader('content-type', 'text/html; charset=utf-8');
                    response.end(previewDocument(`${DEV_PREFIX}${mode}.js`));
                    return;
                }
                let built = dev.get(mode);
                if (built === undefined) {
                    built = bundle(mode, false);
                    dev.set(mode, built);
                    void built
                        .then(({ files }) => server.watcher.add(files))
                        .catch(() => undefined);
                }
                built.then(
                    ({ code }) => {
                        response.setHeader('content-type', 'text/javascript; charset=utf-8');
                        response.end(code);
                    },
                    (failure: unknown) => {
                        dev.delete(mode);
                        response.statusCode = 500;
                        response.end(failure instanceof Error ? failure.message : String(failure));
                    },
                );
            });
        },

        transformIndexHtml: {
            order: 'post',
            handler(html) {
                // A dev server's React refresh preamble is an inline script this policy refuses.
                if (config.command !== 'build') return html;
                const policy = editorPolicy(html, config.env['VITE_API_URL'] as string | undefined);
                return html.replace(
                    '<head>',
                    `<head>\n        <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
                );
            },
        },
    };
}
