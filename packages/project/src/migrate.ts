// The version policy, which is the opposite of the wire's: a file BELOW the current format is moved
// forward one version at a time, and only a file above it is refused. `PROTOCOL_VERSION` refuses a
// mismatch in either direction because a peer can be told to update — a file on disk cannot.

import { PROJECT_FORMAT_VERSION } from './manifest.js';
import { ProjectFormatError } from './validate.js';

/**
 * Moves a parsed project one `formatVersion` forward.
 *
 * A step rewrites content only: the walk stamps the new `formatVersion` itself, so a step that
 * forgets to is not a class of bug that exists.
 */
export type Migration = (project: Record<string, unknown>) => Record<string, unknown>;

/** A target version and every step that reaches it, keyed by the version each step READS. */
export type MigrationChain = { to: number; steps: ReadonlyMap<number, Migration> };

/** The chain this build applies. Its `to` is `PROJECT_FORMAT_VERSION`, which `validate` requires. */
export const MIGRATIONS: MigrationChain = {
    to: PROJECT_FORMAT_VERSION,
    steps: new Map<number, Migration>(),
};

/**
 * Walks a parsed project forward to `chain.to`, or throws if it cannot get there.
 *
 * The chain is a parameter rather than a constant read inside, because a chain is data and the walk
 * over it is not: one function serves the current chain and any older one a tool needs to replay.
 */
export function migrate(value: unknown, chain: MigrationChain = MIGRATIONS): unknown {
    let project = asObject(value);
    let version = readVersion(project['formatVersion']);

    if (version > chain.to) {
        throw new ProjectFormatError(
            'formatVersion',
            `${version} was written by a newer editor than this build reads (${chain.to})`,
        );
    }

    while (version < chain.to) {
        const step = chain.steps.get(version);
        if (step === undefined) {
            throw new ProjectFormatError(
                'formatVersion',
                `no migration from ${version} to ${version + 1}`,
            );
        }
        version += 1;
        project = { ...step(project), formatVersion: version };
    }

    return project;
}

function asObject(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ProjectFormatError('', 'expected a project object');
    }
    return { ...(value as Record<string, unknown>) };
}

function readVersion(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new ProjectFormatError('formatVersion', 'expected a positive integer');
    }
    return value;
}
