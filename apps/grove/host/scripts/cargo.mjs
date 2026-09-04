// `cargo <task>`, or a clear skip when there is no Rust toolchain on this machine.
//
// The repo's gates are one `pnpm run build | test | typecheck | lint` at the root, and a contributor
// working on the TypeScript half should not have to install Rust to run them. A skip says so on one
// line rather than failing with `cargo: not found`, which reads as a broken checkout.

import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const probe = spawnSync('cargo', ['--version'], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
});

if (probe.error !== undefined || probe.status !== 0) {
    process.stdout.write(
        `skipped: no cargo on PATH. Install Rust (https://rustup.rs) to build @grove/host.\n`,
    );
    process.exit(0);
}

const run = spawnSync('cargo', args, { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(run.status ?? 1);
