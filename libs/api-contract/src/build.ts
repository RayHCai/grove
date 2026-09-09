import { z } from 'zod';
import { BundleSet } from './game-data.js';
import { BuildJobId, ContentHash, GameId } from './ids.js';

/** The source is already in @grove/upload-service, so a build names it rather than carrying it. */
export const BuildRequest = z.object({
    gameId: GameId,
    sourceHash: ContentHash,
});
export type BuildRequest = z.infer<typeof BuildRequest>;

export const BuildState = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type BuildState = z.infer<typeof BuildState>;

/** One compiler complaint, positioned the way a creator's editor gutters it. */
export const BuildDiagnostic = z.object({
    severity: z.enum(['error', 'warning']),
    file: z.string(),
    line: z.int().positive(),
    column: z.int().positive(),
    message: z.string(),
});
export type BuildDiagnostic = z.infer<typeof BuildDiagnostic>;

export const BuildJob = z.object({
    jobId: BuildJobId,
    gameId: GameId,
    state: BuildState,
    queuedAt: z.iso.datetime(),
    startedAt: z.iso.datetime().optional(),
    finishedAt: z.iso.datetime().optional(),
    /** Present exactly when the build succeeded — nothing else registers a bundle set. */
    bundles: BundleSet.optional(),
    /** A clean build carries an empty array: warnings come back on a success too. */
    diagnostics: z.array(BuildDiagnostic),
});
export type BuildJob = z.infer<typeof BuildJob>;
