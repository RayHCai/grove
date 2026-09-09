// `staticcheck <packages>` in the calling module, or a clear skip when it is not installed here.
//
// Separate from `go.mjs` because staticcheck is its own binary, not a `go` subcommand. Probed
// directly rather than through `go` the way `gofmt-check.mjs` is: gofmt ships beside the toolchain
// and this does not, so a machine can have Go and still not have this.
//
// cwd is the package pnpm invoked this from, and staticcheck resolves the module and the workspace
// by walking up from there — so one copy of this file serves every module.

import { runToolchain } from './toolchain.mjs';

runToolchain({
    bin: 'staticcheck',
    probe: ['-version'],
    // Kept at or above the toolchain go.work pins: staticcheck reads the standard library with the
    // compiler it was built against, and an older one fails to parse a newer one.
    install: 'go install honnef.co/go/tools/cmd/staticcheck@2026.2.1',
});
