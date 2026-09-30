// tsc is the only tool in this repo that lowers TC39 decorators, so it has to run before the
// linker.

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BundleError } from '../errors.js';

/** A creator's game is a handful of modules; a compile past this is a hung compiler, not a slow one. */
export const DEFAULT_LOWER_TIMEOUT_MS = 60_000;

export interface LowerOptions {
    /** The creator project's tsconfig. Its `lib` must carry `ESNext.Decorators`. */
    readonly tsconfig: string;
    /** Emptied first, so a renamed module cannot leave its old output behind for the linker. */
    readonly outDir: string;
    /** How long tsc may run before it is killed and the compile refused with `tsc-timeout`. */
    readonly timeoutMs?: number | undefined;
}

/** Compiles the project to lowered JS, and answers with the directory holding it. */
export async function lowerScripts(options: LowerOptions): Promise<string> {
    const tsconfig = path.resolve(options.tsconfig);
    const outDir = path.resolve(options.outDir);
    if (!existsSync(tsconfig)) {
        throw new BundleError('tsconfig-missing', `${tsconfig} does not exist`);
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_LOWER_TIMEOUT_MS;

    rmSync(outDir, { recursive: true, force: true });
    const { code, output, timedOut } = await runCompiler(
        [compilerPath(), '-p', tsconfig, '--outDir', outDir],
        timeoutMs,
    );

    if (timedOut) {
        throw new BundleError(
            'tsc-timeout',
            `tsc did not finish on ${tsconfig} within ${timeoutMs} ms`,
        );
    }
    if (code !== 0) {
        throw new BundleError('tsc-failed', `tsc failed on ${tsconfig}:\n${output.trim()}`);
    }
    return outDir;
}

interface Ran {
    code: number | null;
    output: string;
    timedOut: boolean;
}

/** Async, so a service compiling a game still answers its health checks while tsc runs. */
async function runCompiler(args: readonly string[], timeoutMs: number): Promise<Ran> {
    return new Promise<Ran>((resolve, reject) => {
        const child = spawn(process.execPath, args, { windowsHide: true });
        let collected = '';
        let expired = false;
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => (collected += chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => (collected += chunk));
        const deadline = setTimeout(() => {
            expired = true;
            child.kill('SIGKILL');
        }, timeoutMs);
        child.once('error', (error) => {
            clearTimeout(deadline);
            reject(
                new BundleError('tsc-unavailable', 'tsc could not be started', { cause: error }),
            );
        });
        child.once('close', (exit) => {
            clearTimeout(deadline);
            resolve({ code: exit, output: collected, timedOut: expired });
        });
    });
}

function compilerPath(): string {
    const require = createRequire(import.meta.url);
    try {
        return path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
    } catch (error) {
        throw new BundleError(
            'tsc-unavailable',
            'typescript is not installed beside the toolchain',
            {
                cause: error,
            },
        );
    }
}
