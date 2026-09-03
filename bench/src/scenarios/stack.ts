// The whole composition: the integration project's authority, N clients on loopback pairs, one
// hand-turned clock. Core's own scenarios reach none of this — the codec, the broadcast fan-out,
// the input ring and the rewind-and-replay all live above the loop.

import { ManualFrameSource, ScriptedInputDevice } from '@platform/client';
import type { GameClient } from '@platform/client';
import { MemoryKVStore } from '@platform/core';
import { createClient } from '@platform/engine/host';
import { createReadyNullRenderer } from '@platform/renderer/null';
import { loopbackPair } from '@platform/transport';
import type { LoopbackPair } from '@platform/transport';
import { createGameInstance } from '@platform/integration/host';
import { SOAK } from '@platform/integration/worlds/soak';
import { PROJECT } from '@platform/integration/project';
import { CLIENT_SCRIPTS } from '@platform/integration/registry';
import { BINDINGS, CODE_RIGHT, MAX_PLAYERS, SIM_RATE } from '@platform/integration/globals';
import { asyncDriverOf, driverOf, sized } from '../meter.js';
import type { Budget, Driver, Meter, Mode } from '../meter.js';
import type { Measurement } from '../report.js';

const TICK = 1 / SIM_RATE;
const DESIGN = { width: 800, height: 600 };
/** Enough wakes for every join to settle; a session that has not gone live by here has stalled. */
const JOIN_LIMIT = 400;
const WARM_TICKS = 120;

/** Six turns of the microtask queue: what the admission's promise chain needs to settle. */
async function flush(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve();
}

interface Stack {
    /** One authority wake with no client drawing anything: the server's cost, on its own. */
    pumpOnly: Driver;
    /** The same wake plus every tab's display frame — what one process actually pays. */
    withFrames: Driver;
    /** Tabs still live, read after a measurement rather than before it. */
    liveNow: () => number;
    close: () => void;
}

async function stack(tabCount: number): Promise<Stack> {
    let now = 0;
    const pairs: LoopbackPair[] = [];
    const instance = createGameInstance(SOAK, {
        kv: new MemoryKVStore(),
        now: () => now,
        deliver: () => {
            for (const pair of pairs) pair.deliver();
        },
    });
    await instance.started;

    const frames: ManualFrameSource[] = [];
    const devices: ScriptedInputDevice[] = [];
    const clients: GameClient[] = [];

    for (let i = 0; i < tabCount; i++) {
        const pair = loopbackPair();
        pairs.push(pair);
        instance.accept(pair.server, `bench-${i}`);
        const frame = new ManualFrameSource();
        const device = new ScriptedInputDevice();
        const client = createClient({
            transport: pair.client,
            renderer: await createReadyNullRenderer({ design: DESIGN }),
            frames: frame,
            device,
            clock: { nowSeconds: () => now },
            name: `bench-${i}`,
            bindings: BINDINGS,
            predict: true,
            scripts: CLIENT_SCRIPTS,
            project: PROJECT,
        });
        client.start();
        frames.push(frame);
        devices.push(device);
        clients.push(client);
    }

    const framed = async (): Promise<void> => {
        now += TICK;
        instance.pump();
        for (const frame of frames) frame.frame(now);
        await flush();
    };

    for (let i = 0; i < JOIN_LIMIT; i++) {
        await framed();
        if (clients.every((c) => c.state === 'live')) break;
    }
    // Held down for the rest of the run: an idle client sends no frame, so the input ring, the
    // prediction replay and the movement pass would all measure as free.
    for (const device of devices) device.emit({ kind: 'key', code: CODE_RIGHT, down: true });
    for (let i = 0; i < WARM_TICKS; i++) await framed();

    return {
        pumpOnly: driverOf(() => {
            now += TICK;
            instance.pump();
        }),
        withFrames: asyncDriverOf(framed),
        liveNow: () => clients.filter((c) => c.state === 'live').length,
        close: () => instance.close(),
    };
}

/** Tab counts this project admits; past `maxPlayers` a connection is refused, not queued. */
export function tabCounts(): number[] {
    return [...new Set([1, 2, MAX_PLAYERS])].filter((n) => n <= MAX_PLAYERS);
}

async function point(
    meter: Meter,
    mode: Mode,
    id: string,
    scenario: string,
    params: Record<string, string | number | boolean>,
    drive: Driver,
    budget: Budget,
): Promise<Measurement> {
    if (mode === 'gc') {
        const sample = await meter.gcProfile(drive, budget.simSeconds, SIM_RATE);
        return {
            id,
            scenario,
            params,
            nsPerTick: sample.nsPerTick,
            bytesPerTick: sample.bytesPerTick,
            exactBytes: false,
            ticks: sample.simSeconds * sample.simRate,
            simSeconds: sample.simSeconds,
            gc: sample.gc,
        };
    }
    const ticks = await sized(meter, drive, budget.targetMs);
    const timing = await meter.time(drive, ticks);
    const alloc = await meter.allocation(drive, ticks);
    return {
        id,
        scenario,
        params,
        nsPerTick: timing.nsPerTick,
        bytesPerTick: alloc.bytesPerTick,
        exactBytes: alloc.exact,
        ticks: timing.ticks,
        allocTicks: alloc.ticks,
    };
}

/**
 * One session per measurement, never one shared by both.
 *
 * `pumpOnly` advances the clock without letting a tab draw, so the clients it leaves behind have
 * stopped acking and the authority is holding a send set for peers that are not reading. Measuring
 * `withFrames` on that session describes a session recovering from a stall — which is a real thing
 * to measure, and not the thing this scenario claims to be measuring.
 */
export async function stackScenarios(
    meter: Meter,
    mode: Mode,
    budget: Budget,
    counts: readonly number[],
): Promise<Measurement[]> {
    const out: Measurement[] = [];
    for (const tabs of counts) {
        for (const [name, pick] of [
            ['pump-only', (s: Stack) => s.pumpOnly],
            ['with-frames', (s: Stack) => s.withFrames],
        ] as const) {
            const session = await stack(tabs);
            const measurement = await point(
                meter,
                mode,
                `stack.${name}.tabs=${tabs}`,
                `stack.${name}`,
                { tabs, maxPlayers: MAX_PLAYERS },
                pick(session),
                budget,
            );
            // Read after the window: a count taken before it cannot show a tab the measurement
            // itself starved, and a run where that happened is one to distrust.
            measurement.params = { ...measurement.params, liveAfter: session.liveNow() };
            out.push(measurement);
            session.close();
        }
    }
    return out;
}
