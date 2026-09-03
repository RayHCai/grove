// What a result file has to carry to be worth keeping: which commit produced it, on which branch,
// with which tree, on which machine, under which V8 flags.

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { newSpaceMiB } from './meter.js';

export interface GitStamp {
    branch: string;
    commit: string;
    shortCommit: string;
    subject: string;
    /** True when the working tree differs from `commit`, which makes the commit an approximation. */
    dirty: boolean;
}

export interface HostStamp {
    node: string;
    v8: string;
    platform: string;
    arch: string;
    cpuModel: string;
    cpuCount: number;
    totalMemoryMiB: number;
    /** The V8 flags this process was started with; the mode guard reads the same list. */
    execArgv: readonly string[];
    newSpaceMiB: number;
}

const UNKNOWN = '(unknown)';

function git(args: readonly string[]): string {
    try {
        return execFileSync('git', args as string[], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        // A tarball or a worktree with no git is still a legitimate place to run a benchmark.
        return '';
    }
}

export function gitStamp(): GitStamp {
    const commit = git(['rev-parse', 'HEAD']);
    return {
        branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) || UNKNOWN,
        commit: commit || UNKNOWN,
        shortCommit: commit === '' ? UNKNOWN : commit.slice(0, 7),
        subject: git(['log', '-1', '--pretty=%s']) || UNKNOWN,
        dirty: git(['status', '--porcelain']) !== '',
    };
}

export function hostStamp(): HostStamp {
    const cpus = os.cpus();
    return {
        node: process.version,
        v8: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
        cpuModel: cpus[0]?.model.trim() ?? UNKNOWN,
        cpuCount: cpus.length,
        totalMemoryMiB: Math.round(os.totalmem() / 1024 / 1024),
        execArgv: [...process.execArgv],
        newSpaceMiB: newSpaceMiB(),
    };
}
