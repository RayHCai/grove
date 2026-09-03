// A world whose whole game is one player's interface: an always-on deck, a bag opened over it, and
// a button for every verb the HUD owns.
//
// The calls under test run on the TAB rather than the authority — `hud` resolves the current
// runtime's local player and a server runtime has none — so the hosts here are screens, the scripts
// are client-located, and the readings are widgets instead of replicated fields.
//
// Every reading is written back out through `hud` itself, which is what lets a test read
// `hud.screens` or `hud.player` off the same sink a browser's UI layer draws from.

import type { HUD, HUDScreen } from '@platform/engine';
import { ClientScript, Countdown, hud, onEnd, onPress, onStart } from '@platform/engine';
import { templateId } from '@platform/project';
import { ASSET_DISC, DISC_ASSET, defineWorld, sprite } from '../world.js';
import type { World } from '../world.js';

export const TEMPLATE_PIP = 'pip';

export const SCRIPT_DECK = 'deck';
export const SCRIPT_BAG = 'bag';

// The bag sorts before the deck and opens after it, so one reading cannot stand in for the other.
export const SCREEN_DECK = 'deck';
export const SCREEN_BAG = 'bag';

/** A screen nothing opens and a widget nothing writes — the null answer both lookups are owed. */
export const NOTHING = 'nothing';
/** What a reading writes where a lookup answered null, since a widget carries text and not null. */
export const NONE = 'none';

/** The widgets this HUD draws. A test reads every one of them back off the client's own sink. */
export const V = {
    label: 'label',
    count: 'count',
    meter: 'meter',
    badge: 'badge',
    clock: 'clock',
    reached: 'reached',
    greeting: 'greeting',
    presses: 'presses',
    screens: 'screens',
    open: 'open-screens',
    bag: 'bag-state',
    player: 'player',
    echo: 'echo',
} as const;

/** The buttons a test presses, named apart from the widgets because a press names a widget too. */
export const B = {
    count: 'count-up',
    meter: 'fill',
    overfill: 'overfill',
    badge: 'dress',
    clock: 'wind',
    retime: 'rewind',
    hide: 'hide',
    show: 'show',
    disable: 'disable',
    enable: 'enable',
    openBag: 'open-bag',
    closeBag: 'close-bag',
    screenOpens: 'screen-opens',
    screenCloses: 'screen-closes',
    closeAll: 'close-all',
    unlist: 'unlist',
    relist: 'relist',
    report: 'report',
    both: 'both',
    tally: 'tally',
} as const;

export const LABEL_READY = 'ready';
export const METER_FRACTION = 0.4;
/** Past full, so a reading of it says whether anything between the verb and the sink clamps. */
export const OVERFILL = 1.5;
export const TIMER_SECONDS = 3;
export const RETIMED_SECONDS = 8;
export const BAG_OPEN = 'open';
export const BAG_SHUT = 'shut';

/** What `hud.widget` answers, without naming a type the creator-facing barrel does not export. */
type WidgetState = ReturnType<HUD['widget']>;

function describeScreen(screen: HUDScreen | null): string {
    return screen === null ? NONE : `${screen.name}:${screen.visible}:${screen.scripts.length}`;
}

function describeWidget(widget: WidgetState): string {
    return widget === null ? NONE : `${widget.text ?? ''}:${widget.visible}:${widget.enabled}`;
}

export class Bag extends ClientScript<HUDScreen> {
    /** Client state, which is the whole reason a screen holds a script — and must not outlive it. */
    #pressed = 0;

    @onStart
    greet(): void {
        hud.text(V.greeting, `${BAG_OPEN}:${this.host.name}`);
        hud.number(V.presses, this.#pressed);
    }

    @onEnd
    farewell(): void {
        hud.text(V.greeting, `${BAG_SHUT}:${this.host.name}`);
    }

    @onPress(B.tally)
    tally(): void {
        this.#pressed = this.#pressed + 1;
        hud.number(V.presses, this.#pressed);
    }

    /** The deck answers the same widget name, so a press proves which screen it was scoped to. */
    @onPress(B.both)
    answer(): void {
        hud.text(V.reached, SCREEN_BAG);
    }
}

export class Deck extends ClientScript<HUDScreen> {
    #count = 0;
    /** The countdown handed to `hud.timer`, kept so a later press can prove the sink holds it live. */
    #clock: Countdown | null = null;

    @onStart
    dress(): void {
        hud.text(V.label, LABEL_READY);
        hud.number(V.count, this.#count);
        // `open` is the only call that mints a screen, so registering the bag's class means opening
        // it once and closing it again.
        const bag = hud.open(SCREEN_BAG);
        bag.addScript(Bag);
        bag.close();
    }

    @onPress(B.count)
    countUp(): void {
        this.#count = this.#count + 1;
        hud.number(V.count, this.#count);
    }

    @onPress(B.meter)
    fill(): void {
        hud.bar(V.meter, METER_FRACTION);
    }

    @onPress(B.overfill)
    overfill(): void {
        hud.bar(V.meter, OVERFILL);
    }

    @onPress(B.badge)
    badge(): void {
        // The key rather than an `Asset`: a mirror's `loadGame` is handed no manifest, so the table
        // a screen script would resolve one from is empty on the only machine `hud` runs on.
        hud.icon(V.badge, ASSET_DISC);
    }

    @onPress(B.clock)
    wind(): void {
        const clock = new Countdown(TIMER_SECONDS);
        clock.start();
        this.#clock = clock;
        hud.timer(V.clock, clock);
    }

    /** Touches the countdown and never the HUD, so what the sink reports next can only be the object. */
    @onPress(B.retime)
    rewind(): void {
        this.#clock?.reset(RETIMED_SECONDS);
    }

    @onPress(B.hide)
    hideLabel(): void {
        hud.hide(V.label);
    }

    @onPress(B.show)
    showLabel(): void {
        hud.show(V.label);
    }

    @onPress(B.disable)
    disableLabel(): void {
        hud.disable(V.label);
    }

    @onPress(B.enable)
    enableLabel(): void {
        hud.enable(V.label);
    }

    @onPress(B.openBag)
    openBag(): void {
        hud.open(SCREEN_BAG);
    }

    @onPress(B.closeBag)
    closeBag(): void {
        hud.close(SCREEN_BAG);
    }

    @onPress(B.screenOpens)
    letBagOpen(): void {
        hud.screen(SCREEN_BAG)?.open();
    }

    @onPress(B.screenCloses)
    letBagClose(): void {
        hud.screen(SCREEN_BAG)?.close();
    }

    @onPress(B.closeAll)
    shutEverything(): void {
        hud.closeAll();
    }

    /** The state half of the open transition, called with none of the transition around it. */
    @onPress(B.unlist)
    unlist(): void {
        hud.screen(SCREEN_BAG)?.setVisible(false);
    }

    @onPress(B.relist)
    relist(): void {
        hud.screen(SCREEN_BAG)?.setVisible(true);
    }

    @onPress(B.both)
    answer(): void {
        hud.text(V.reached, SCREEN_DECK);
    }

    @onPress(B.report)
    report(): void {
        hud.text(
            V.screens,
            hud.screens
                .map((screen) => screen.name)
                .toSorted()
                .join(' '),
        );
        // Unsorted, unlike the line above: `openScreens` answers bottom to top, and sorting it
        // would throw away the only claim it makes.
        hud.text(V.open, hud.openScreens.map((screen) => screen.name).join(' '));
        hud.text(
            V.bag,
            `${describeScreen(hud.screen(SCREEN_BAG))}|${describeScreen(hud.screen(NOTHING))}`,
        );
        hud.text(V.player, hud.player.id);
        hud.text(
            V.echo,
            `${describeWidget(hud.widget(V.label))}|${describeWidget(hud.widget(NOTHING))}`,
        );
    }
}

export const HUD_WORLD: World = defineWorld({
    id: 'hud',
    assets: [DISC_ASSET],
    scripts: [
        {
            id: SCRIPT_DECK,
            export: 'Deck',
            path: 'src/worlds/hud.ts',
            location: 'client',
            host: 'screen',
            ctor: Deck,
        },
        {
            id: SCRIPT_BAG,
            export: 'Bag',
            path: 'src/worlds/hud.ts',
            location: 'client',
            host: 'screen',
            ctor: Bag,
        },
    ],
    templates: [sprite(TEMPLATE_PIP)],
    // One placed sprite, so a joining tab is owed a snapshot with something in it and this suite is
    // not also driving the empty-world path.
    entities: [
        {
            id: 'the-pip',
            template: templateId(TEMPLATE_PIP),
            parent: null,
            transform: { x: 0, y: 0 },
            tags: [],
            scripts: [],
        },
    ],
    screens: [{ name: SCREEN_DECK, script: Deck as never }],
    // A numeric widget on the renderer's own `ui` surface, which is the only proof `hud` reaches art.
    mirrorWidget: V.count,
});
