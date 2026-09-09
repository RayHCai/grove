// Shells to a compiler that may not be installed, and reports the absence as a skip.
//
// The exit code is what CI reads: a machine WITH the toolchain must fail on a real error, and a
// machine without one must not fail at all — so the probe is separate from the run, and only the
// probe is allowed to turn a failure into a zero.

import { spawnSync } from 'node:child_process';

const shell = process.platform === 'win32';

/** True when `bin` answers `probe`. On Windows a missing binary is a non-zero shell, not an error. */
export function installed(bin, probe) {
    // GOTOOLCHAIN=local so the probe answers whether this machine HAS the tool, rather than whether
    // it can fetch the one go.work pins — an offline machine with Go would otherwise read as having none.
    const env = { ...process.env, GOTOOLCHAIN: 'local' };
    const result = spawnSync(bin, probe, { stdio: 'ignore', shell, env });
    return result.error === undefined && result.status === 0;
}

/** The toolchains whose absence is a failure here rather than a skip, as `go,cargo,staticcheck`. */
function required() {
    return (process.env.GROVE_REQUIRE_TOOLCHAIN ?? '').split(',').map((name) => name.trim());
}

export function skip(bin, install) {
    const name = process.env.npm_package_name ?? bin;
    const absence = `no ${bin} on PATH. ${install} to build ${name}.`;

    // Unset, the skip keeps the root gates runnable on a machine that has only Node. CI names the
    // toolchains it installed, because there their absence is a broken install rather than a machine
    // that never had them, and a skip would be a green job over code nothing compiled. Named rather
    // than a flag, so a tool CI does not install still skips instead of failing the gate.
    if (required().includes(bin)) {
        process.stderr.write(`required: ${absence}\n`);
        process.exit(1);
    }

    process.stdout.write(`skipped: ${absence}\n`);
    process.exit(0);
}

/** @param {{ bin: string; probe: string[]; install: string }} tool */
export function runToolchain(tool) {
    if (!installed(tool.bin, tool.probe)) skip(tool.bin, tool.install);

    const run = spawnSync(tool.bin, process.argv.slice(2), { stdio: 'inherit', shell });
    process.exit(run.status ?? 1);
}
