import { randomUUID } from 'node:crypto';
import { BuildJobId } from '@grove/api-contract';
import type {
    BuildDiagnostic,
    BuildJob,
    BuildRequest,
    BundleSet,
    GameId,
} from '@grove/api-contract';
import type { FastifyBaseLogger } from 'fastify';

/** How long a settled record is kept: long enough for the editor that queued it to read it. */
const RETAIN_MS = 60 * 60 * 1000;

/** A burst inside that window still has a ceiling, and one game may ask for fifty at a time. */
const RETAIN = 500;

/** What one compile produced: the bundle set to register, or the complaints that stopped it. */
export type BuildOutcome =
    | { ok: true; bundles: BundleSet; diagnostics: BuildDiagnostic[] }
    | { ok: false; diagnostics: BuildDiagnostic[] };

/**
 * The toolchain: fetch the source a request names, compile it, and answer with the bundle set a
 * session loads or the diagnostics that stopped it.
 *
 * The signal aborts when the build is called off or runs past its deadline; a compile that honours
 * it hands the box's cores back to the next build in line.
 */
export interface Compiler {
    compile(request: BuildRequest, signal: AbortSignal): Promise<BuildOutcome>;
}

export type CancelOutcome = 'cancelled' | 'unknown' | 'finished';

/** Every job this service knows about, and the only thing a route is allowed to touch. */
export interface JobQueue {
    enqueue(request: BuildRequest): Promise<BuildJob>;
    get(jobId: BuildJobId): Promise<BuildJob | undefined>;
    cancel(jobId: BuildJobId): Promise<CancelOutcome>;
    listForGame(gameId: GameId, limit: number): Promise<BuildJob[]>;
}

/** How long one compile may hold the slot, and how much of what it produced the box keeps. */
export interface QueueLimits {
    deadlineMs: number;
    retainMs?: number;
    retain?: number;
}

/** A failure of the box and not of the source: fixed words, positioned in no creator's file. */
function boxFault(message: string): BuildOutcome {
    return {
        ok: false,
        diagnostics: [{ severity: 'error', file: 'build', line: 1, column: 1, message }],
    };
}

/** Only a deadline ever shows this to a creator: a cancel dropped the record before it aborted. */
function calledOff(): BuildOutcome {
    return boxFault('the build ran longer than this box allows');
}

/** Settles when the compile is called off, so the queue stops waiting on a toolchain that may not. */
function abandoned(signal: AbortSignal): Promise<BuildOutcome> {
    return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(calledOff()), { once: true });
    });
}

/**
 * One build at a time, in the order they arrived — two compiles sharing a box's cores finish later
 * than the same two run back to back, and a worker pool lands on this without a route moving.
 */
export class InMemoryJobQueue implements JobQueue {
    readonly #compiler: Compiler;
    readonly #logger: FastifyBaseLogger;
    readonly #deadlineMs: number;
    readonly #retainMs: number;
    readonly #retain: number;
    readonly #jobs = new Map<BuildJobId, BuildJob>();
    /** The compile in flight, which is how a cancel and a deadline reach the box's cores. */
    readonly #running = new Map<BuildJobId, AbortController>();
    /** The tail every accepted build is appended to; that append is the whole scheduler. */
    #chain: Promise<void> = Promise.resolve();

    constructor(compiler: Compiler, logger: FastifyBaseLogger, limits: QueueLimits) {
        this.#compiler = compiler;
        this.#logger = logger;
        this.#deadlineMs = limits.deadlineMs;
        this.#retainMs = limits.retainMs ?? RETAIN_MS;
        this.#retain = limits.retain ?? RETAIN;
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

        // The record goes before the abort, so the compile that stops has nothing to write back.
        this.#jobs.delete(jobId);
        this.#running.get(jobId)?.abort();
        this.#logger.info({ jobId, gameId: job.gameId }, 'build cancelled');
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
        this.#logger.info({ jobId, gameId: started.gameId }, 'build running');

        const control = new AbortController();
        this.#running.set(jobId, control);
        const outcome = await this.#compile(jobId, request, control);
        this.#running.delete(jobId);

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
        this.#logger.info({ jobId, gameId: running.gameId, state: settled.state }, 'build settled');
        this.#forget();
    }

    async #compile(
        jobId: BuildJobId,
        request: BuildRequest,
        control: AbortController,
    ): Promise<BuildOutcome> {
        // The deadline is raced and not merely signalled: a toolchain that ignores its abort would
        // otherwise hold the one slot, and every build behind it, for as long as it liked.
        const deadline = setTimeout(() => {
            this.#logger.error(
                { jobId, gameId: request.gameId, deadlineMs: this.#deadlineMs },
                'build deadline passed',
            );
            control.abort();
        }, this.#deadlineMs);

        try {
            return await Promise.race([
                this.#toolchain(jobId, request, control.signal),
                abandoned(control.signal),
            ]);
        } finally {
            clearTimeout(deadline);
        }
    }

    async #toolchain(
        jobId: BuildJobId,
        request: BuildRequest,
        signal: AbortSignal,
    ): Promise<BuildOutcome> {
        try {
            return await this.#compiler.compile(request, signal);
        } catch (error) {
            // A build called off is not a fault, and an error line here alerts on every cancel.
            if (signal.aborted) return calledOff();
            // The toolchain's own words name hosts and paths inside the fleet, so they stop here.
            this.#logger.error({ err: error, jobId, gameId: request.gameId }, 'toolchain failed');
            return boxFault('the build box could not run this build');
        }
    }

    // A build box outlives every job it ran, so a settled record is kept for the polls that follow
    // the build rather than for the life of the process.
    #forget(): void {
        const cutoff = Date.now() - this.#retainMs;
        const kept: BuildJobId[] = [];
        for (const [jobId, job] of this.#jobs) {
            if (job.state !== 'succeeded' && job.state !== 'failed') continue;
            if (Date.parse(job.finishedAt ?? job.queuedAt) < cutoff) this.#jobs.delete(jobId);
            else kept.push(jobId);
        }

        // Insertion order is arrival order, so a burst inside the window sheds its oldest first.
        const excess = kept.length - this.#retain;
        for (const jobId of kept.slice(0, Math.max(excess, 0))) this.#jobs.delete(jobId);
    }
}
