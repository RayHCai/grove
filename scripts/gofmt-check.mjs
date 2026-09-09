// Fails when `gofmt` would rewrite a file in the calling module.
//
// `gofmt -l` lists the offenders and exits zero either way, so a gate has to read its output rather
// than its status. Separate from `go.mjs` because gofmt is its own binary, not a `go` subcommand.

import { spawnSync } from 'node:child_process';
import { installed, skip } from './toolchain.mjs';

// Probed through `go`, which ships gofmt beside itself — gofmt with no arguments reads stdin
// forever, so it has no probe of its own that terminates.
if (!installed('go', ['version'])) skip('go', 'Install Go (https://go.dev/dl)');

// Paths are optional so the pre-commit hook can hand over the staged files alone; with none, the
// whole of the calling module.
const shell = process.platform === 'win32';

const args = process.argv.slice(2);
// Quoted for the Windows shell, which concatenates argv into one string and would otherwise read a
// staged path with a space in it as two files it cannot open.
const paths = (args.length > 0 ? args : ['.']).map((path) => (shell ? `"${path}"` : path));

const listed = spawnSync('gofmt', ['-l', ...paths], {
    encoding: 'utf8',
    shell,
});

if (listed.status !== 0) {
    process.stderr.write(listed.stderr ?? 'gofmt failed\n');
    process.exit(listed.status ?? 1);
}

const offenders = listed.stdout.split('\n').filter((line) => line.trim() !== '');
if (offenders.length > 0) {
    process.stderr.write(`gofmt would rewrite:\n${offenders.map((f) => `  ${f}`).join('\n')}\n`);
    process.exit(1);
}
