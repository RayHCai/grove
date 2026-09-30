#!/usr/bin/env node
// A service's dev loop without a shell: tsc rebuilds dist on every source edit, and node restarts
// on every rebuild. Run from the service's own directory; the argument is its entry.

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const entry = process.argv[2] ?? 'dist/main.js';
const require = createRequire(path.join(process.cwd(), 'package.json'));
const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');

// Built once up front, so the first `node --watch` has an entry to start rather than a crash.
const first = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { stdio: 'inherit' });
if (first.status !== 0) process.exit(first.status ?? 1);

const children = [
    spawn(process.execPath, [tsc, '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'], {
        stdio: 'inherit',
    }),
    spawn(process.execPath, ['--watch', entry], { stdio: 'inherit' }),
];

const stop = () => {
    for (const child of children) child.kill();
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
for (const child of children) {
    child.once('exit', (code) => {
        stop();
        process.exitCode = code ?? 0;
    });
}
