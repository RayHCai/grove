// `terraform validate` over every environment root under the calling package.
//
// Validation needs a provider schema, so each root is initialised first — with `-backend=false`,
// because checking that the configuration is well-formed must not require a credential or reach the
// state bucket. The modules are validated through the roots that call them: a module validated
// alone reports every unset variable the root supplies.

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { installed, skip } from './toolchain.mjs';

const bin = 'terraform';
const install = 'Install Terraform (https://developer.hashicorp.com/terraform/install)';
const shell = process.platform === 'win32';

if (!installed(bin, ['version'])) skip(bin, install);

const roots = join(process.cwd(), 'environments');

for (const entry of readdirSync(roots, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const cwd = join(roots, entry.name);
    for (const args of [['init', '-backend=false', '-input=false'], ['validate']]) {
        const run = spawnSync(bin, args, { cwd, stdio: 'inherit', shell });
        if (run.status !== 0) process.exit(run.status ?? 1);
    }
}
