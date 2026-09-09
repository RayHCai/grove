import { randomUUID } from 'node:crypto';
import { BuildJobId } from '@grove/api-contract';
import type {
    BuildDiagnostic,
    BuildJob,
    BuildRequest,
    BundleSet,
    GameId,
} from '@grove/api-contract';

/** What one compile produced: the bundle set to register, or the complaints that stopped it. */
export type BuildOutcome =
    | { ok: true; bundles: BundleSet; diagnostics: BuildDiagnostic[] }
    | { ok: false; diagnostics: BuildDiagnostic[] };

/**
 * The toolchain: fetch the source a request names, run `tsc` and the bundler over it, store the
 * artifacts in `@grove/upload-service` and register the set with `@grove/game-manager`.
 */
export interface Compiler {
    compile(request: BuildRequest): Promise<BuildOutcome>;
}

export type CancelOutcome = 'cancelled' | 'unknown' | 'finished';

/** Every job this service knows about, and the only thing a route is allowed to touch. */
export interface JobQueue {
    enqueue(request: BuildRequest): Promise<BuildJob>;
    get(jobId: BuildJobId): Promise<BuildJob | undefined>;
    cancel(jobId: BuildJobId): Promise<CancelOutcome>;
    listForGame(gameId: GameId, limit: number): Promise<BuildJob[]>;
}

/** The toolchain seam with nothing behind it: a child `tsc` and a bundler land here. */
export const unattachedToolchain: Compiler = {
    compile: () => Promise.reject(new Error('no toolchain attached')),
};

/**
 * One build at a time, in the order they arrived — two compiles sharing a box's cores finish later
 * than the same two run back to back, and a worker pool lands on this without a route moving.
 */
export class InMemoryJobQueue implements JobQueue {
    readonly #compiler: Compiler;
    readonly #jobs = new Map<BuildJobId, BuildJob>();
    /** The tail every accepted build is appended to; that append is the whole scheduler. */
    #chain: Promise<void> = Promise.resolve();

    constructor(compiler: Compiler) {
        this.#compiler = compiler;
    }

    async enqueue(request: BuildRequest): Promise<BuildJob> {
        const job: BuildJob = {
            jobId: BuildJobId.parse(randomUUID()),
            gameId: request.gameId,
            state: 'queued',
            queuedAt: new Date().toISOString(),
            diagnostics: [],
        };

        this.#jobs.set(job.jobId, job);
        this.#chain = this.#chain.then(() => this.#run(job.jobId, request));
        return job;
    }

    async get(jobId: BuildJobId): Promise<BuildJob | undefined> {
        return this.#jobs.get(jobId);
    }

    // A cancel drops the record rather than parking it in a state: `BuildState` has no `cancelled`,
    // and reporting a withdrawn build as `failed` would redden an editor over something that never
    // ran.
    async cancel(jobId: BuildJobId): Promise<CancelOutcome> {
        const job = this.#jobs.get(jobId);
        if (job === undefined) return 'unknown';
        if (job.state === 'succeeded' || job.state === 'failed') return 'finished';

        this.#jobs.delete(jobId);
        return 'cancelled';
    }

    // Insertion order is the real order: two builds queued in the same millisecond sort arbitrarily
    // by `queuedAt`.
    async listForGame(gameId: GameId, limit: number): Promise<BuildJob[]> {
        const forGame = [...this.#jobs.values()].filter((job) => job.gameId === gameId);
        return forGame.toReversed().slice(0, limit);
    }

    async #run(jobId: BuildJobId, request: BuildRequest): Promise<void> {
        // A cancel took the record before this build's turn came, so there is nothing left to run.
        const started = this.#jobs.get(jobId);
        if (started === undefined) return;
        this.#jobs.set(jobId, {
            ...started,
            state: 'running',
            startedAt: new Date().toISOString(),
        });

        const outcome = await this.#compile(request);

        // A cancel deleted the record while the toolchain held it, so the outcome has nowhere to go.
        const running = this.#jobs.get(jobId);
        if (running === undefined) return;

        const settled: BuildJob = {
            ...running,
            state: outcome.ok ? 'succeeded' : 'failed',
            finishedAt: new Date().toISOString(),
            diagnostics: outcome.diagnostics,
        };
        this.#jobs.set(jobId, outcome.ok ? { ...settled, bundles: outcome.bundles } : settled);
    }

    async #compile(request: BuildRequest): Promise<BuildOutcome> {
        try {
            return await this.#compiler.compile(request);
        } catch (error) {
            // A toolchain that died carries no source position, so its failure is pinned to the
            // object it was handed.
            return {
                ok: false,
                diagnostics: [
                    {
                        severity: 'error',
                        file: request.sourceHash,
                        line: 1,
                        column: 1,
                        message: error instanceof Error ? error.message : 'the build did not run',
                    },
                ],
            };
        }
    }
}
