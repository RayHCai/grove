// One player's interface. The widget verbs write authored state and push it at the HUD seam; the
// screens are the hosts a ClientScript<HUDScreen> attaches to. Client-side by construction — `hud`
// resolves the current runtime's state, and a server runtime simply has no local player.

import type { ScriptProps } from '@platform/project';
import type { AssetRef } from './assets.js';
import type { BaseScript } from '../script/bases.js';
import type { Countdown } from './wrappers.js';
import type { Player } from './player.js';
import type { HUDWidgetState } from './seams.js';
import type { Runtime } from './runtime.js';
import { currentRuntime, hasRuntime } from './runtime.js';
import { screenKey } from './hosts.js';

/** A creator script class, as a screen holds one until it is opened. */
type ScreenScript = new (props?: ScriptProps) => BaseScript<HUDScreen>;

/** One registered class and the props it was configured with, held until the open that wires it. */
type ScreenAttachment = { klass: ScreenScript; props?: ScriptProps };

export class HUDScreen {
    readonly name: string;
    /** Attached at open and discarded at close, so a menu reopens with fresh client state. */
    readonly #scripts: ScreenAttachment[] = [];
    #visible = false;

    constructor(name: string) {
        this.name = name;
    }

    get visible(): boolean {
        return this.#visible;
    }

    /** @internal — the HUD owns the open/close transition; this is the state half of it. */
    setVisible(visible: boolean): void {
        this.#visible = visible;
    }

    /** @internal — the classes to attach on the next open, in declaration order. */
    get scripts(): readonly ScreenAttachment[] {
        return this.#scripts;
    }

    open(): void {
        hud.open(this.name);
    }

    close(): void {
        hud.close(this.name);
    }

    // Registered rather than attached: a screen never opened has no script instances, so the class
    // is held until the open that wires it.
    addScript(script: ScreenScript, props?: ScriptProps): this {
        this.#scripts.push({ klass: script, ...(props === undefined ? {} : { props }) });
        return this;
    }
}

/** The per-runtime HUD state the module-level `hud` const is a facade over. */
export class HUDState {
    readonly screens = new Map<string, HUDScreen>();
    /** Open screens bottom to top, which is open order. */
    readonly openOrder: string[] = [];
    readonly widgets = new Map<string, HUDWidgetState>();
}

export class HUD {
    /**
     * The local player, whose interface this is.
     *
     * Throws rather than reading undefined off a declared field: `hud` is a client-side const, and a
     * runtime with no local player is a server one, where reaching it is the load-time error the
     * wiring rules already name.
     */
    get player(): Player {
        const player = runtime()?.localPlayer;
        if (!player) {
            throw new Error(
                'hud has no player — the HUD is one client’s, and this runtime has none',
            );
        }
        return player;
    }

    text(widget: string, value: string): void {
        this.#write(widget, (w) => {
            w.text = value;
        });
    }

    number(widget: string, value: number): void {
        this.#write(widget, (w) => {
            w.number = value;
        });
    }

    bar(widget: string, fraction: number): void {
        this.#write(widget, (w) => {
            w.fraction = fraction;
        });
    }

    icon(widget: string, asset: AssetRef): void {
        this.#write(widget, (w) => {
            w.icon = asset;
        });
    }

    timer(widget: string, countdown: Countdown): void {
        this.#write(widget, (w) => {
            w.countdown = countdown;
        });
    }

    show(widget: string): void {
        this.#write(widget, (w) => {
            w.visible = true;
        });
    }

    hide(widget: string): void {
        this.#write(widget, (w) => {
            w.visible = false;
        });
    }

    enable(widget: string, enabled = true): void {
        this.#write(widget, (w) => {
            w.enabled = enabled;
        });
    }

    disable(widget: string): void {
        this.enable(widget, false);
    }

    /**
     * Opens a screen, attaching its scripts and running their `@onStart`. Idempotent.
     *
     * The screen is minted on first mention: with no panel, naming one in code is how it comes to
     * exist, and the declared return type is non-null.
     */
    open(screen: string): HUDScreen {
        const rt = runtime();
        const found = this.#ensure(screen);
        if (found.visible || rt === undefined) return found;

        // Wired first: a script's location is rejected at attach time, and a LoadError thrown after
        // the screen was marked visible would leave one open that nothing ever put on screen.
        for (const attachment of found.scripts) {
            rt.wiring?.attachToScreen(found, attachment.klass as never, attachment.props);
        }

        found.setVisible(true);
        rt.hud?.openOrder.push(screen);
        rt.hudSink.screen(screen, true);
        // Immediate rather than deferred to the starts pass, and then dropped from its queue: a
        // menu that appeared but ran nothing until the next tick reads as a dropped frame, and
        // starting twice is worse. Last, so a handler that opens a second screen from its own
        // @onStart sees this one open.
        rt.instances.dropPendingStarts(screenKey(screen));
        void dispatchScreen(rt, screen, 'onStart', '@start');
        return found;
    }

    /** Closes a screen, running `@onEnd` and discarding its instances. Idempotent. */
    close(screen: string): void {
        const rt = runtime();
        const found = rt?.hud?.screens.get(screen);
        if (rt === undefined || found === undefined || !found.visible) return;

        // Before the teardown, or the handler runs against a host record that is already gone.
        void dispatchScreen(rt, screen, 'onEnd', '@end');
        found.setVisible(false);
        const at = rt.hud?.openOrder.indexOf(screen) ?? -1;
        if (at >= 0) rt.hud?.openOrder.splice(at, 1);
        // Instances and host both: closing DISCARDS client state, so a reopen builds fresh ones.
        rt.instances.removeHost(screenKey(screen));
        rt.hosts.remove(screenKey(screen));
        rt.hudSink.screen(screen, false);
    }

    closeAll(): void {
        // Over a copy, because `close` splices the list it walks.
        for (const name of Array.from(runtime()?.hud?.openOrder ?? [])) this.close(name);
    }

    /** An authored screen, open or not; null for a name nothing has mentioned. */
    screen(name: string): HUDScreen | null {
        return runtime()?.hud?.screens.get(name) ?? null;
    }

    get screens(): HUDScreen[] {
        return [...(runtime()?.hud?.screens.values() ?? [])];
    }

    get openScreens(): HUDScreen[] {
        const state = runtime()?.hud;
        if (state === undefined) return [];
        return state.openOrder
            .map((name) => state.screens.get(name))
            .filter((s): s is HUDScreen => s !== undefined);
    }

    /**
     * @internal — the live state of one widget, or null until a verb has written it.
     *
     * Not creator surface: the widget verbs are the write side and the `HUDSink` is the read side,
     * so a creator reading a widget back would be asking the engine what it just told it.
     */
    widget(name: string): Readonly<HUDWidgetState> | null {
        return runtime()?.hud?.widgets.get(name) ?? null;
    }

    #ensure(name: string): HUDScreen {
        const state = runtime()?.hud;
        if (state === undefined) return new HUDScreen(name);
        const found = state.screens.get(name);
        if (found) return found;
        const made = new HUDScreen(name);
        state.screens.set(name, made);
        return made;
    }

    // A verb outside a loaded world writes nothing rather than throwing: the whole surface is
    // no-op-safe, and a creator call is not where a missing runtime should surface.
    #write(widget: string, patch: (state: HUDWidgetState) => void): void {
        const rt = runtime();
        const state = rt?.hud;
        if (rt === undefined || state === undefined) return;
        let record = state.widgets.get(widget);
        if (record === undefined) {
            record = { visible: true, enabled: true };
            state.widgets.set(widget, record);
        }
        patch(record);
        rt.hudSink.widget(widget, record);
    }
}

function runtime(): Runtime | undefined {
    return hasRuntime() ? currentRuntime() : undefined;
}

function dispatchScreen(
    rt: Runtime,
    screen: string,
    kind: 'onStart' | 'onEnd',
    event: string,
): Promise<void> {
    const key = screenKey(screen);
    return rt.dispatcher.dispatch(
        rt.instances.forHost(key),
        kind,
        event,
        key,
        { data: {}, dt: 1 / rt.simRate, alive: kind === 'onStart' },
        // A screen is one machine's, so only client-located handlers can be on it anyway; naming the
        // set explicitly keeps a screen from depending on which role built the runtime.
        { activeLocations: CLIENT_ONLY, tick: rt.tick },
    );
}

const CLIENT_ONLY: ReadonlySet<'server' | 'client' | 'synced'> = new Set(['client']);

export const hud: HUD = new HUD();
