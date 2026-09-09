// `terraform <task>` in the calling package, or a clear skip when there is no Terraform here.
//
// The same bargain `cargo.mjs` and `go.mjs` strike: one `pnpm run` at the root stays green on a
// machine that has only Node, and a missing toolchain reads as a skipped line rather than a failing
// command.

import { runToolchain } from './toolchain.mjs';

runToolchain({
    bin: 'terraform',
    probe: ['version'],
    install: 'Install Terraform (https://developer.hashicorp.com/terraform/install)',
});
