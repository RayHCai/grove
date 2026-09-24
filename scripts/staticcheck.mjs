// Probed directly rather than through `go`: gofmt ships beside the toolchain and this does not,
// so a machine can have Go and still not have this.

import { runToolchain } from './toolchain.mjs';

runToolchain({
    bin: 'staticcheck',
    probe: ['-version'],
    // Kept at or above the toolchain go.mod pins: staticcheck reads the standard library with the
    // compiler it was built against, and an older one fails to parse a newer one.
    install: 'go install honnef.co/go/tools/cmd/staticcheck@2026.2.1',
});
