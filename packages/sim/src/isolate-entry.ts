// The isolate has no module loader and no I/O, so a global is the whole of what a host can reach.
// JSON in and JSON out: the batch is the only thing that crosses.

import type { Codec, Message } from '@platform/transport';
import { jsonCodec } from '@platform/transport';
import type { InputBatch, LogLine, OutputBatch, Send } from './batch.js';
import { Sim } from './sim.js';
import type { SimConfig } from './sim.js';

/** What a host calls, in this order, exactly once per name. */
export interface IsolateEntry {
    /** Builds the world. The config is the JSON the host was started with. */
    boot(config: string): void;
    /** One fixed step: an `InputBatch` as JSON in, an {@link EncodedBatch} as JSON out. */
    tick(batch: string): string;
    /** Releases the world and answers the last batch, whose `saves` a host must drain. */
    close(): string;
}

/**
 * One send whose envelope is already on the wire's terms. These bytes must be the CODEC's,
 * not `JSON.stringify`'s, which turns `NaN` and `Infinity` into `null`.
 */
export interface EncodedSend extends Omit<Send, 'envelope'> {
    envelope: string;
}

/** An {@link OutputBatch} with every envelope encoded — what an out-of-process host takes. */
export interface EncodedBatch extends Omit<OutputBatch, 'sends'> {
    sends: EncodedSend[];
}

declare global {
    // `var` rather than `let`: only a `var` declaration widens `globalThis`, which is the whole
    // point.
    var __grove: IsolateEntry | undefined;
}

/**
 * Publishes the entry a host drives, over a `Sim` this bundle builds. `build` takes config, not
 * a `Sim`: booting at evaluation time would run every Game `@onStart` before there is a clock.
 */
export function installIsolateEntry(
    build: (config: SimConfig) => Sim,
    codec: Codec = jsonCodec,
): void {
    let sim: Sim | null = null;

    const answer = (out: OutputBatch): string => JSON.stringify(encodeBatch(out, codec));

    globalThis.__grove = {
        boot(config: string): void {
            if (sim !== null) throw new Error('the isolate entry is already booted');
            sim = build(JSON.parse(config) as SimConfig);
        },
        tick(batch: string): string {
            if (sim === null) throw new Error('the isolate entry has not booted');
            return answer(sim.tick(JSON.parse(batch) as InputBatch));
        },
        close(): string {
            if (sim === null) throw new Error('the isolate entry has not booted');
            return answer(sim.close());
        },
    };
}

/**
 * Encodes every envelope for the wire, dropping any the codec refuses — one bad envelope costs
 * that send, not the tick that produced it. The loss leaves a line, so it is never silent.
 */
function encodeBatch(out: OutputBatch, codec: Codec): EncodedBatch {
    const sends: EncodedSend[] = [];
    const log: LogLine[] = out.log;
    for (const send of out.sends) {
        try {
            const frame = codec.encode(send.envelope as unknown as Message);
            // A string, because a global is the only thing an isolate boundary carries and a global
            // carries no bytes: a binary codec belongs to a host that owns both ends of its socket,
            // which is not the arrangement this entry exists for.
            if (typeof frame !== 'string') {
                throw new TypeError('a binary codec cannot cross an isolate boundary');
            }
            sends.push({ to: send.to, envelope: frame, class: send.class });
        } catch (error) {
            log.push({
                level: 'error',
                line: `send-dropped kind=${send.envelope.kind} reason=${error instanceof Error ? error.message : String(error)}`,
            });
        }
    }
    return { ...out, sends, log };
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
