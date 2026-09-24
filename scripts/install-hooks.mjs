// `prepare` runs on every install: the one inside a service image, where `turbo prune` copied no
// `.git`, and the one pnpm fires before a workspace script, where `--production` has pruned lefthook
// itself. Either way a hook install with nowhere to write hooks — or no lefthook to write them — is
// a no-op rather than a failure, because a failure here fails whatever task triggered the install.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { installed } from './toolchain.mjs';

if (
    process.env.GROVE_SKIP_HOOKS === '1' ||
    !existsSync('.git') ||
    !installed('lefthook', ['version'])
) {
    process.exit(0);
}

// `shell` for the `.cmd` shim pnpm puts on PATH for this on Windows.
const { status } = spawnSync('lefthook', ['install'], { stdio: 'inherit', shell: true });
process.exit(status ?? 1);
