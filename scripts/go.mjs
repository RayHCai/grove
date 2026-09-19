// `go <task>` in the calling package, or a clear skip when there is no Go toolchain here.
// cwd is the package pnpm invoked this from, and `go` walks up to the module and the workspace.

import { runToolchain } from './toolchain.mjs';

runToolchain({
    bin: 'go',
    probe: ['version'],
    install: 'Install Go (https://go.dev/dl)',
});
