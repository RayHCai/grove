// A world whose whole game is timers: every duration is registered from inside a handler on a real
// host, and every firing is counted into a `@serverState` a client is told about.
//
// Nothing here reads a clock. Drift is measured in TICKS against the sim's own update pass, because
// a repeat that reloaded from the tick it fired on rather than from its due tick would still look
// right in seconds while slipping a tick per firing.

import type { Entity, Game } from '@platform/engine';
import {
    ServerScript,
    after,
    every,
    game,
    onPress,
    onStart,
    onUpdate,
    serverState,
    sleep,
} from '@platform/engine';
import { templateId } from '@platform/project';
import { SIM_RATE, TEMPLATE_AVATAR, attach, defineWorld, sprite } from '../world.js';
import type { World } from '../world.js';

export const SCRIPT_CLOCK = 'clock';
export const SCRIPT_TICKER = 'ticker';

export const TEMPLATE_TICKER = 'ticker';
export const TAG_TICKER = 'ticker';

/** One widget per timer verb: a press names the call, and the name is what the test reads back. */
export const W = {
    armAfter: 'arm-after',
    stopAfter: 'stop-after',
    armEvery: 'arm-every',
    stopEvery: 'stop-every',
    nap: 'nap',
    armSub: 'arm-sub',
    killTicker: 'kill-ticker',
} as const;

/** Replicated readings, named so none of them collides with a member `Game` already owns. */
export const S = {
    afterFires: 'afterFires',
    everyFires: 'everyFires',
    everyGap: 'everyGap',
    everyDrifted: 'everyDrifted',
    napStarted: 'napStarted',
    napEnded: 'napEnded',
    tickerFires: 'tickerFires',
    tickerWoke: 'tickerWoke',
    subFires: 'subFires',
    tickFires: 'tickFires',
    armedTicks: 'armedTicks',
    zeroAfterAt: 'zeroAfterAt',
} as const;

/** Long enough that a settle well short of it proves the one-shot had not fired early. */
export const AFTER_SECONDS = 0.5;
export const EVERY_SECONDS = 0.1;
export const NAP_SECONDS = 0.5;
export const TICKER_SECONDS = 0.1;
/** Long enough that a tab can join and press before the ticker's parked handler is ever due. */
export const TICKER_NAP_SECONDS = 3;
/** A tenth of a tick, so a conversion that rounded down rather than up would drop it entirely. */
export const SUB_TICK_SECONDS = 1 / (SIM_RATE * 10);

export const AFTER_TICKS = Math.round(AFTER_SECONDS * SIM_RATE);
export const EVERY_TICKS = Math.round(EVERY_SECONDS * SIM_RATE);
export const NAP_TICKS = Math.round(NAP_SECONDS * SIM_RATE);
export const TICKER_NAP_TICKS = Math.round(TICKER_NAP_SECONDS * SIM_RATE);

export class Clock extends ServerScript<Game> {
    @serverState afterFires = 0;
    @serverState everyFires = 0;
    /** Ticks between the last two repeats, so drift is arithmetic rather than a stopwatch. */
    @serverState everyGap = 0;
    @serverState everyDrifted = false;
    @serverState napStarted = 0;
    @serverState napEnded = 0;
    @serverState tickerFires = 0;
    @serverState tickerWoke = false;
    @serverState subFires = 0;
    @serverState tickFires = 0;
    @serverState armedTicks = 0;
    /** What `subFires` had reached when a zero-second `after` came due. */
    @serverState zeroAfterAt = 0;

    #stopAfter: (() => void) | null = null;
    #stopEvery: (() => void) | null = null;
    #ticks = 0;
    #lastFire = -1;
    #subArmed = false;

    @onUpdate
    tally(): void {
        this.#ticks = this.#ticks + 1;
        if (this.#subArmed) this.armedTicks = this.armedTicks + 1;
    }

    @onPress(W.armAfter)
    doArmAfter(): void {
        this.#stopAfter = after(AFTER_SECONDS, () => {
            this.afterFires = this.afterFires + 1;
        });
    }

    @onPress(W.stopAfter)
    doStopAfter(): void {
        this.#stopAfter?.();
    }

    @onPress(W.armEvery)
    doArmEvery(): void {
        this.#stopEvery = every(EVERY_SECONDS, () => {
            this.#repeated();
        });
    }

    @onPress(W.stopEvery)
    doStopEvery(): void {
        this.#stopEvery?.();
    }

    @onPress(W.nap)
    async doNap(): Promise<void> {
        this.napStarted = this.napStarted + 1;
        await sleep(NAP_SECONDS);
        this.napEnded = this.napEnded + 1;
    }

    /** Three sub-tick-or-one-tick durations armed together, so one tick fires all three or none. */
    @onPress(W.armSub)
    doArmSub(): void {
        if (this.#subArmed) return;
        this.#subArmed = true;
        // Registration order is firing order within a tick, so the zero-second one below reads a
        // `subFires` this tick's own repeat has already bumped.
        every(SUB_TICK_SECONDS, () => {
            this.subFires = this.subFires + 1;
        });
        every(1 / SIM_RATE, () => {
            this.tickFires = this.tickFires + 1;
        });
        after(0, () => {
            this.zeroAfterAt = this.subFires;
        });
    }

    @onPress(W.killTicker)
    doKillTicker(): void {
        for (const entity of game.find({ tag: TAG_TICKER })) entity.destroy();
    }

    /** Called by a timer another host owns, so that host's destruction is visible from the Game. */
    countTicker(): void {
        this.tickerFires = this.tickerFires + 1;
    }

    wakeTicker(): void {
        this.tickerWoke = true;
    }

    #repeated(): void {
        if (this.#lastFire >= 0) {
            const gap = this.#ticks - this.#lastFire;
            // The first gap has nothing to disagree with; drift is a gap that then changed.
            if (this.everyGap !== 0 && gap !== this.everyGap) this.everyDrifted = true;
            this.everyGap = gap;
        }
        this.#lastFire = this.#ticks;
        this.everyFires = this.everyFires + 1;
    }
}

/** An entity whose only job is to own timers, so destroying it is what the suite measures. */
export class Ticker extends ServerScript<Entity> {
    @onStart
    async begin(): Promise<void> {
        // Resolved before the await: the ambient runtime belongs to the pass, and a continuation
        // that resumes between ticks has none to reach `game` through.
        const clock = game.getScript(Clock);
        every(TICKER_SECONDS, () => {
            clock?.countTicker();
        });
        await sleep(TICKER_NAP_SECONDS);
        clock?.wakeTicker();
    }
}

export const TIMER_WORLD: World = defineWorld({
    id: 'timers',
    scripts: [
        {
            id: SCRIPT_CLOCK,
            export: 'Clock',
            path: 'src/worlds/timers.ts',
            location: 'server',
            host: 'game',
            ctor: Clock,
        },
        {
            id: SCRIPT_TICKER,
            export: 'Ticker',
            path: 'src/worlds/timers.ts',
            location: 'server',
            host: 'entity',
            ctor: Ticker,
        },
    ],
    templates: [
        sprite(TEMPLATE_AVATAR),
        sprite(TEMPLATE_TICKER, [attach(SCRIPT_TICKER)], 0xd6b48f),
    ],
    entities: [
        {
            id: 'the-ticker',
            template: templateId(TEMPLATE_TICKER),
            parent: null,
            transform: { x: 0, y: 0 },
            tags: [TAG_TICKER],
            scripts: [],
        },
    ],
    gameScripts: [attach(SCRIPT_CLOCK)],
});
