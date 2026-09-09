// `go <task>` in the calling package, or a clear skip when there is no Go toolchain here.
//
// The same bargain `cargo.mjs` strikes: the root gates stay runnable on a machine that has only
// Node, and a missing toolchain reads as a skipped line rather than a failing command.
//
// cwd is the package pnpm invoked this from, and `go` resolves the module and the workspace by
// walking up from there — so one copy of this file serves every module.

import { runToolchain } from './toolchain.mjs';

runToolchain({
    bin: 'go',
    probe: ['version'],
    install: 'Install Go (https://go.dev/dl)',
});
