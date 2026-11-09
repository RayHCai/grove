// Each pin is read from the file that already owns it, so this script never holds a second copy.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shell } from './toolchain.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function pinned(path, pattern) {
    return readFileSync(join(root, path), 'utf8').match(pattern)?.[1] ?? '?';
}

/** The first version-shaped token `bin` prints, or undefined when it is not on PATH. */
function found(bin, args, cwd = root) {
    const env = { ...process.env, GOTOOLCHAIN: 'local' };
    const run = spawnSync(bin, args, { cwd, shell, env, encoding: 'utf8' });
    if (run.error !== undefined || run.status !== 0) return undefined;
    return `${run.stdout}${run.stderr}`.match(/\d+\.\d+(\.\d+)?/u)?.[0];
}

const tools = [
    { name: 'node', pin: pinned('.node-version', /^v?(\S+)/u), have: process.versions.node },
    {
        name: 'pnpm',
        pin: pinned('package.json', /"packageManager": "pnpm@([^"]+)"/u),
        have: found('pnpm', ['--version']),
    },
    { name: 'go', pin: pinned('go.mod', /^toolchain go(\S+)/mu), have: found('go', ['version']) },
    {
        name: 'cargo',
        pin: pinned('apps/grove/rust-toolchain.toml', /^channel = "([^"]+)"/mu),
        have: found('cargo', ['--version'], join(root, 'apps/grove')),
    },
    {
        name: 'staticcheck',
        pin: pinned('scripts/staticcheck.mjs', /^const version = '([^']+)'/mu),
        have: found('staticcheck', ['-version']),
    },
    {
        name: 'terraform',
        pin: pinned('.github/workflows/ci.yml', /terraform_version: (\S+)/u),
        have: found('terraform', ['version']),
    },
    { name: 'docker', pin: '-', have: found('docker', ['--version']) },
];

const required = new Set(
    (process.env.GROVE_REQUIRE_TOOLCHAIN ?? '').split(',').map((name) => name.trim()),
);
let failed = false;

for (const tool of tools) {
    let verdict;
    if (tool.have === undefined) {
        // Absent, a gate skips the packages that need it and still passes.
        verdict = required.has(tool.name) ? 'MISSING (required)' : 'missing: its gates skip';
        failed ||= required.has(tool.name);
    } else if (tool.pin === '-' || tool.pin === tool.have) verdict = 'ok';
    else verdict = 'differs from the pin';
    const have = tool.have ?? '-';
    process.stdout.write(
        `${tool.name.padEnd(12)} pin ${tool.pin.padEnd(10)} found ${have.padEnd(10)} ${verdict}\n`,
    );
}

process.exit(failed ? 1 : 0);
