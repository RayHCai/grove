// `pnpm dev`: every piece of Grove up on one machine, idempotently; the readme's "Running it locally" lists the steps and flags.

import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shell } from './toolchain.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const flags = new Set(process.argv.slice(2));
for (const flag of flags) {
    if (!['--fleet', '--no-docker', '--no-native'].includes(flag)) {
        fail(`unknown flag ${flag}; the flags are --fleet, --no-docker and --no-native`);
    }
}

const STORES = ['postgres', 'redis', 'localstack'];
const NATIVE = ['game-manager', 'server-manager', 'asset-upload-service'];
const FLEET = ['instance-manager'];
// The compose services that `pnpm dev` runs on the host instead. If an earlier
// `docker compose --profile app up` left them running, they hold the ports the host ones need.
const ON_HOST = ['api', 'api-migrate', 'game-builder'];

function step(message) {
    process.stdout.write(`\n\x1b[1m▸ ${message}\x1b[0m\n`);
}

function fail(message) {
    process.stderr.write(`\n\x1b[31mpnpm dev: ${message}\x1b[0m\n`);
    process.exit(1);
}

function run(bin, args, { cwd = root, env = process.env, quiet = false } = {}) {
    const result = spawnSync(bin, args, { cwd, env, shell, stdio: quiet ? 'ignore' : 'inherit' });
    return result.error === undefined && result.status === 0;
}

/** `KEY=value` lines by key; comments and blanks dropped. */
function entries(file) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/u);
    return new Map(
        lines.flatMap((line) => {
            const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u)?.[1];
            return key === undefined ? [] : [[key, line.trim()]];
        }),
    );
}

step('env files');
for (const dir of ['.', 'apps/grove/api', 'apps/grove/game-builder']) {
    const env = join(root, dir, '.env');
    const example = join(root, dir, '.env.example');
    if (!existsSync(example)) continue;
    if (!existsSync(env)) {
        copyFileSync(example, env);
        process.stdout.write(`created ${join(dir, '.env')} from its .env.example\n`);
        continue;
    }
    // A `.env` made before a key was added to the example. Missing keys are appended with the
    // example's value; a value already there is never touched.
    const have = entries(env);
    const missing = [...entries(example)].filter(([key]) => !have.has(key));
    if (missing.length > 0) {
        const text = readFileSync(env, 'utf8');
        const lead = text.length === 0 || text.endsWith('\n') ? '' : '\n';
        const added = missing.map(([, line]) => line).join('\n');
        appendFileSync(env, `${lead}\n# Added by pnpm dev from .env.example\n${added}\n`);
        const keys = missing.map(([key]) => key).join(', ');
        process.stdout.write(`${join(dir, '.env')}: added ${keys}\n`);
    }
}

if (!flags.has('--no-docker')) {
    if (!run('docker', ['info'], { quiet: true })) {
        fail(
            'Docker is not running. Start Docker Desktop, or pass --no-docker to skip the stores.',
        );
    }

    step('stores: postgres, redis, localstack');
    run('docker', ['compose', 'stop', ...ON_HOST], { quiet: true });
    if (!run('docker', ['compose', 'up', '--detach', '--wait', ...STORES])) {
        fail('the stores did not come up healthy; `docker compose logs` says why.');
    }

    step('migrations');
    if (!run('pnpm', ['--filter', '@grove/api', 'db:deploy'])) {
        fail('the migrations did not apply.');
    }

    if (!flags.has('--no-native')) {
        const services = flags.has('--fleet') ? [...NATIVE, ...FLEET] : NATIVE;
        step(`native services: ${services.join(', ')}`);
        // Not `--wait`: these talk to the api, which only starts in the next step. `--build` is
        // cheap when nothing changed, and keeps an image from lagging the source behind it.
        const env = { ...process.env, DEV_API_URL: 'http://host.docker.internal:4000' };
        if (!run('docker', ['compose', 'up', '--detach', '--build', ...services], { env })) {
            fail('the native services did not start; `docker compose logs` says why.');
        }
    }
}

step('api, game-builder, platform :5175, editor :5176, player :5177');
const turbo = spawnSync('pnpm', ['exec', 'turbo', 'run', 'dev', '--filter=./apps/grove/*'], {
    cwd: root,
    shell,
    stdio: 'inherit',
});
process.exit(turbo.status ?? 0);
