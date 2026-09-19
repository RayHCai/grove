import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(HERE, '../../..');
export const FIXTURES = path.join(HERE, 'fixtures');

/** A cleared scratch dir per case, under `node_modules` so a turbo restore cannot sweep it. */
export function scratch(name: string): string {
    const dir = path.join(HERE, '..', 'node_modules', '.cache', 'scripting-tests', name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return dir;
}
