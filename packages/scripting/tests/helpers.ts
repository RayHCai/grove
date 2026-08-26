import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(HERE, '../../..');
export const FIXTURES = path.join(HERE, 'fixtures');

/**
 * A cleared scratch directory for one case.
 *
 * Under `node_modules` rather than `dist`, so a turbo cache restore of the build output cannot
 * sweep it, and so `@platform/core` still resolves from the chunks written into it.
 */
export function scratch(name: string): string {
    const dir = path.join(HERE, '..', 'node_modules', '.cache', 'scripting-tests', name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return dir;
}
