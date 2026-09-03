// The entry point. Checks the process flags against the requested mode before anything is measured,
// runs each selected scenario in a process of its own, and files one JSON per run under `runs/`.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Meter, assertMode } from './meter.js';
import type { Mode } from './meter.js';
import { buildRun, printRun, writeRun } from './report.js';
import type { Measurement } from './report.js';
import { SCENARIOS, selectScenarios } from './scenarios/index.js';

interface Args {
    mode: Mode;
    only: string[];
    quick: boolean;
    list: boolean;
    outDir: string;
    /** Set in a child process: measure exactly this scenario and write its result to stdout. */
    child: string | null;
}

const DEFAULT_OUT = fileURLToPath(new URL('../runs/', import.meta.url));
const SELF = fileURLToPath(import.meta.url);

function parseArgs(argv: readonly string[]): Args {
    const args: Args = {
        mode: 'alloc',
        only: [],
        quick: false,
        list: false,
        outDir: DEFAULT_OUT,
        child: null,
    };
    for (const arg of argv) {
        if (arg === '--quick') args.quick = true;
        else if (arg === '--list') args.list = true;
        else if (arg.startsWith('--mode=')) {
            const mode = arg.slice('--mode='.length);
            if (mode !== 'alloc' && mode !== 'gc') {
                throw new Error(`--mode must be alloc or gc, not "${mode}"`);
            }
            args.mode = mode;
        } else if (arg.startsWith('--only=')) {
            args.only.push(...arg.slice('--only='.length).split(',').filter(Boolean));
        } else if (arg.startsWith('--out=')) args.outDir = arg.slice('--out='.length);
        else if (arg.startsWith('--child=')) args.child = arg.slice('--child='.length);
        else throw new Error(`unknown argument "${arg}"`);
    }
    return args;
}

function list(): void {
    for (const scenario of SCENARIOS) {
        console.log(`${scenario.name.padEnd(20)} [${scenario.modes.join(',')}] ${scenario.about}`);
    }
}

/** Measures one scenario in this process. Only ever the whole of a child's work. */
async function measureOne(name: string, mode: Mode, quick: boolean): Promise<Measurement[]> {
    const scenario = SCENARIOS.find((s) => s.name === name);
    if (scenario === undefined) throw new Error(`unknown scenario "${name}"`);
    const meter = new Meter();
    try {
        return await scenario.run(meter, mode, quick);
    } finally {
        meter.dispose();
    }
}

/**
 * Runs one scenario in a fresh process and reads back its measurements.
 *
 * Isolation is not tidiness here, it is correctness. V8's optimisation state is a function of
 * everything the process has already run: the same thousand-entity world measured on its own
 * allocates 8.5 MB a tick, and measured after a sweep that has shown `Loop.step` five other world
 * shapes it allocates 573 KB — both figures honest, both collection-free, and not comparable. A
 * scenario is only ever compared against the same scenario from another run, so what each one needs
 * is the same starting state every time, which is a process that has run nothing else.
 */
function runChild(name: string, args: Args): Promise<Measurement[]> {
    const argv = [
        ...process.execArgv,
        SELF,
        `--child=${name}`,
        `--mode=${args.mode}`,
        ...(args.quick ? ['--quick'] : []),
    ];
    return new Promise((resolve, reject) => {
        // stderr inherited so a scenario's own progress reaches the terminal; stdout is the result.
        const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            out += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`${name} exited with code ${code ?? 'null'}`));
                return;
            }
            try {
                resolve(JSON.parse(out) as Measurement[]);
            } catch {
                reject(new Error(`${name} wrote no readable result`));
            }
        });
    });
}

async function main(argv: readonly string[]): Promise<number> {
    let args: Args;
    try {
        args = parseArgs(argv);
        if (args.list) {
            list();
            return 0;
        }
        // Before the first world is built: a mode mismatch makes every number below wrong in a way
        // the numbers themselves do not show.
        assertMode(args.mode);
    } catch (err) {
        // The message alone: a stack trace through the argument parser tells a caller nothing that
        // the sentence does not, and buries it.
        console.error(err instanceof Error ? err.message : String(err));
        return 1;
    }

    if (args.child !== null) {
        const measurements = await measureOne(args.child, args.mode, args.quick);
        process.stdout.write(JSON.stringify(measurements));
        return 0;
    }

    const startedAt = new Date();
    const measurements: Measurement[] = [];
    let failed = 0;
    for (const scenario of selectScenarios(args.only)) {
        if (!scenario.modes.includes(args.mode)) {
            console.error(`skipping ${scenario.name}: it has no ${args.mode} answer`);
            continue;
        }
        console.error(`running ${scenario.name}...`);
        try {
            measurements.push(...(await runChild(scenario.name, args)));
        } catch (err) {
            // One scenario that cannot run must not cost the run every other scenario's numbers.
            failed += 1;
            console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    const run = buildRun({ mode: args.mode, startedAt, measurements });
    printRun(run);
    const path = writeRun(run, args.outDir);

    console.log(
        `\n${run.mode} run of ${run.measurements.length} measurements in ${(run.durationMs / 1000).toFixed(1)}s`,
    );
    console.log(`${run.git.branch} @ ${run.git.shortCommit}${run.git.dirty ? ' (dirty)' : ''}`);
    console.log(path);
    if (failed > 0) console.error(`${failed} scenario(s) failed to run`);
    return failed > 0 ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
