// Probed directly rather than through `go`: gofmt ships beside the toolchain and this does not,
// so a machine can have Go and still not have this.

import { runToolchain } from './toolchain.mjs';

// Kept at or above the toolchain go.mod pins: staticcheck reads the standard library with the
// compiler it was built against, and an older one fails to parse a newer one. CI installs the
// version named on this line, so it is the one place the pin lives.
const version = '2026.2.1';

runToolchain({
    bin: 'staticcheck',
    probe: ['-version'],
    install: `go install honnef.co/go/tools/cmd/staticcheck@${version}`,
});
