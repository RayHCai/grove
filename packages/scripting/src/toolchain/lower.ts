// tsc is the only tool in this repo that lowers TC39 decorators, so it has to run before the linker.

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BundleError } from '../errors.js';

export interface LowerOptions {
    /** The creator project's tsconfig. Its `lib` must carry `ESNext.Decorators`. */
    readonly tsconfig: string;
    /** Emptied first, so a renamed module cannot leave its old output behind for the linker. */
    readonly outDir: string;
}

/** Compiles the project to lowered JS, and answers with the directory holding it. */
export function lowerScripts(options: LowerOptions): string {
    const tsconfig = path.resolve(options.tsconfig);
    const outDir = path.resolve(options.outDir);
    if (!existsSync(tsconfig)) {
        throw new BundleError('tsconfig-missing', `${tsconfig} does not exist`);
    }

    rmSync(outDir, { recursive: true, force: true });
    const result = spawnSync(
        process.execPath,
        [compilerPath(), '-p', tsconfig, '--outDir', outDir],
        { encoding: 'utf8', windowsHide: true },
    );
    if (result.error) {
        throw new BundleError('tsc-unavailable', 'tsc could not be started', {
            cause: result.error,
        });
    }
    if (result.status !== 0) {
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
        throw new BundleError('tsc-failed', `tsc failed on ${tsconfig}:\n${output}`);
    }
    return outDir;
}

function compilerPath(): string {
    const require = createRequire(import.meta.url);
    return path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
}
