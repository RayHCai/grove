// Rolls the sim and everything it imports into one classic script the isolate can evaluate.
//
// One file, not a module graph: an isolate has no module loader and no `node_modules` to resolve
// against, so a bare specifier reaching it is a specifier nothing can answer. `platform: 'neutral'`
// is what makes esbuild refuse a Node built-in here rather than shim one in — this bundle runs
// somewhere that has none.

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The API rather than the CLI, because `esbuild/bin/esbuild` is a launcher script only on Windows —
// everywhere else it is the platform binary itself, which `node` cannot read.
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../dist/sim.js');
mkdirSync(dirname(out), { recursive: true });

await build({
    entryPoints: [resolve(here, 'entry.ts')],
    bundle: true,
    // An IIFE, so the whole thing is one classic script with no exports to resolve and no
    // top-level await for a host with no event loop to drive.
    format: 'iife',
    platform: 'neutral',
    target: 'es2022',
    outfile: out,
});

process.stdout.write(`sim bundle: ${out}\n`);
