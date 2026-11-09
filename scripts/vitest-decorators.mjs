// Vitest's own transform leaves standard decorators unlowered, which Node cannot run; esbuild lowers
// them, so a suite can import the source it tests rather than a build of it.

import { transform } from 'esbuild';

/** A decorator at the start of a line: cheap enough to test every module, and rare enough to matter. */
const DECORATED = /^\s*@[A-Za-z_$]/mu;
const TYPESCRIPT = /\.[cm]?tsx?$/u;

/** A Vite plugin that hands each decorated TypeScript module to esbuild before Vitest sees it. */
export function standardDecorators() {
    return {
        name: 'grove:standard-decorators',
        enforce: 'pre',
        async transform(code, id) {
            const file = id.split('?')[0] ?? id;
            if (
                !TYPESCRIPT.test(file) ||
                file.includes('/node_modules/') ||
                !DECORATED.test(code)
            ) {
                return null;
            }
            const out = await transform(code, {
                loader: file.endsWith('x') ? 'tsx' : 'ts',
                format: 'esm',
                target: 'es2022',
                sourcefile: file,
                sourcemap: 'external',
            });
            return { code: out.code, map: out.map };
        },
    };
}
