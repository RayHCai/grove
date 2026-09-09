// Rolls the sim and everything it imports into one classic script the isolate can evaluate.
//
// One file, not a module graph: an isolate has no module loader and no `node_modules` to resolve
// against, so a bare specifier reaching it is a specifier nothing can answer. `platform: 'neutral'`
// is what makes esbuild refuse a Node built-in here rather than shim one in — this bundle runs
// somewhere that has none.

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../dist/sim.js');
mkdirSync(dirname(out), { recursive: true });

execFileSync(
    process.execPath,
    [
        // Resolved rather than pathed: pnpm hoists nothing, so where the binary lands is its
        // business and a relative walk out of this directory is a guess about it.
        createRequire(import.meta.url).resolve('esbuild/bin/esbuild'),
        resolve(here, 'entry.ts'),
        '--bundle',
        // An IIFE, so the whole thing is one classic script with no exports to resolve and no
        // top-level await for a host with no event loop to drive.
        '--format=iife',
        '--platform=neutral',
        '--target=es2022',
        `--outfile=${out}`,
    ],
    { stdio: 'inherit' },
);

process.stdout.write(`sim bundle: ${out}\n`);
