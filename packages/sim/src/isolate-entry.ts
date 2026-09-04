// The contract a bundle running inside a host's isolate publishes: three functions on one global.
//
// The isolate has no module loader and no I/O, so a host cannot import anything out of the bundle it
// evaluated — a global is the whole of what it can reach. JSON in and JSON out for the same reason:
// the batch is the only thing that crosses, and a shape neither side can hold a reference to is a
// shape neither side can be surprised by.

import type { InputBatch } from './batch.js';
import { Sim } from './sim.js';
import type { SimConfig } from './sim.js';

/** What a host calls, in this order, exactly once per name. */
export interface IsolateEntry {
    /** Builds the world. The config is the JSON the host was started with. */
    boot(config: string): void;
    /** One fixed step. Takes an `InputBatch` as JSON and answers an `OutputBatch` as JSON. */
    tick(batch: string): string;
    /** Releases the world and answers the last batch, whose `saves` a host must drain. */
    close(): string;
}

declare global {
    // `var` rather than `let`: only a `var` declaration widens `globalThis`, which is the whole point.
    // eslint-disable-next-line no-var
    var __grove: IsolateEntry | undefined;
}

/**
 * Publishes the entry a host drives, over a `Sim` this bundle builds.
 *
 * `build` takes the host's config rather than a `Sim` directly, because the world must not exist
 * until the host says so: a bundle that booted at evaluation time would run every Game `@onStart`
 * before the host had a clock to advance them with.
 */
export function installIsolateEntry(build: (config: SimConfig) => Sim): void {
    let sim: Sim | null = null;

    globalThis.__grove = {
        boot(config: string): void {
            if (sim !== null) throw new Error('the isolate entry is already booted');
            sim = build(JSON.parse(config) as SimConfig);
        },
        tick(batch: string): string {
            if (sim === null) throw new Error('the isolate entry has not booted');
            return JSON.stringify(sim.tick(JSON.parse(batch) as InputBatch));
        },
        close(): string {
            if (sim === null) throw new Error('the isolate entry has not booted');
            return JSON.stringify(sim.close());
        },
    };
}

/** Reads back what {@link installIsolateEntry} published, which is what a host reaches for. */
export function isolateEntry(): IsolateEntry {
    const entry = globalThis.__grove;
    if (entry === undefined) throw new Error('no isolate entry was installed');
    return entry;
}

/** Forgets the published entry, so one process can build a second world in a fresh bundle. */
export function clearIsolateEntry(): void {
    globalThis.__grove = undefined;
}

/** The default build: a `Sim` straight off the host's config, for a bundle that adds no scripts. */
export function simFromConfig(config: SimConfig): Sim {
    return new Sim({ config });
}
