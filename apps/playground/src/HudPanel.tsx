// The interface, drawn from the HUD seam rather than from React state.
//
// Nothing here decides what a widget says. The authority writes `@serverState`, the bridge turns
// that into `hud.text` / `hud.number` / `hud.bar`, `ClientHUDSink` collects it and tells this
// component to look again — so the only thing this file owns is the layout. That is the whole
// reason the HUD is a seam and not a prop: a panel-authored interface has to be drawable by a host
// that does not know the game.
//
// The ready button is the same seam in the other direction: `pressWidget` runs the screen's own
// handler locally and puts a press on the interaction frame, which is the one creator-facing
// client→server command channel there is.

import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { ClientHUDSink, HUDWidgetView } from '@platform/client';
import {
    BOARD_SIZE,
    SCREEN_LOBBY,
    SCREEN_RESULTS,
    WIDGET_BEST,
    WIDGET_CLOCK,
    WIDGET_LIFETIME,
    WIDGET_PHASE,
    WIDGET_READY,
    WIDGET_SCORE,
    WIDGET_SLOT,
    WIDGET_WASTED,
    WIDGET_WINNER,
    rankWidget,
    tintCss,
} from './scripts/globals';

interface HudView {
    widgets: Map<string, HUDWidgetView>;
    screens: string[];
}

const EMPTY: HudView = { widgets: new Map(), screens: [] };

export interface HudPanelProps {
    /** `null` before the session exists. */
    hud: ClientHUDSink | null;
    /** Presses the ready widget, scoped to the lobby screen. */
    onReady: () => void;
    /** Disabled until the session can send, whatever the widget itself says. */
    live: boolean;
}

export function HudPanel({ hud, onReady, live }: HudPanelProps): React.JSX.Element | null {
    const view = useHudView(hud);
    if (view.widgets.size === 0) return null;

    const ready = view.widgets.get(WIDGET_READY);
    const clock = view.widgets.get(WIDGET_CLOCK);
    const inLobby = view.screens.includes(SCREEN_LOBBY);
    const inResults = view.screens.includes(SCREEN_RESULTS);

    return (
        <div className="hud">
            <div className="hud__bar">
                {/* Which leaves on the stage are worth triple to this tab. The seat comes off the
                    wire, not off `player.index`, so the swatch and the sprite read one number. */}
                <span className="hud__me">
                    <i
                        className="hud__swatch"
                        style={{ background: tintCss(number(view, WIDGET_SLOT)) }}
                        aria-hidden="true"
                    />
                    yours
                </span>

                <strong className="hud__phase">{text(view, WIDGET_PHASE)}</strong>

                {/* Two verbs, one widget: `hud.number` and `hud.bar` write different fields of the
                    same record, which is what lets a timer read as both a count and a fill. */}
                <span className="hud__clock">
                    <i
                        className="hud__fill"
                        style={{ width: `${(clock?.fraction ?? 0) * 100}%` }}
                    />
                    <b>{clock?.number ?? 0}</b>
                </span>

                <Stat label="score" value={number(view, WIDGET_SCORE)} />
                <Stat label="wasted" value={number(view, WIDGET_WASTED)} />
            </div>

            {inLobby && (
                <div className="hud__panel">
                    <button
                        type="button"
                        className="hud__ready"
                        onClick={onReady}
                        // Both halves matter: the widget's own `enabled` is the authority's answer,
                        // and `live` is whether this session could send the press at all.
                        disabled={!live || ready?.enabled === false}
                    >
                        {ready?.text ?? 'ready up'}
                    </button>
                    <div className="hud__totals">
                        <Stat label="lifetime" value={number(view, WIDGET_LIFETIME)} />
                        <Stat label="best round" value={number(view, WIDGET_BEST)} />
                    </div>
                </div>
            )}

            {inResults && (
                <div className="hud__panel">
                    <strong className="hud__winner">
                        {text(view, WIDGET_WINNER) || 'no winner'}
                    </strong>
                    <ol className="hud__board">
                        {rows(view).map((line, index) => (
                            // The row's widget name is its identity; the index is only its order.
                            <li key={rankWidget(index)}>{line}</li>
                        ))}
                    </ol>
                </div>
            )}
        </div>
    );
}

/**
 * Subscribes to the HUD sink.
 *
 * The snapshot is rebuilt inside the change callback and handed back by reference, because
 * `useSyncExternalStore` re-reads it on every render and compares by identity — building a fresh
 * `widgets` array per read would re-render forever.
 */
function useHudView(sink: ClientHUDSink | null): HudView {
    const held = useRef<HudView>(EMPTY);

    const subscribe = useCallback(
        (notify: () => void) => {
            if (sink === null) {
                held.current = EMPTY;
                return () => {};
            }
            held.current = snapshot(sink);
            return sink.onChange(() => {
                held.current = snapshot(sink);
                notify();
            });
        },
        [sink],
    );

    const read = useCallback(() => held.current, []);
    return useSyncExternalStore(subscribe, read, read);
}

function snapshot(sink: ClientHUDSink): HudView {
    return {
        widgets: new Map(sink.widgets.map((widget) => [widget.name, widget])),
        screens: sink.openScreens,
    };
}

function text(view: HudView, name: string): string {
    const widget = view.widgets.get(name);
    return widget?.visible === false ? '' : (widget?.text ?? '');
}

function number(view: HudView, name: string): number {
    return view.widgets.get(name)?.number ?? 0;
}

/** Every ranked row the board wrote, in order, skipping the ones it hid. */
function rows(view: HudView): string[] {
    const out: string[] = [];
    for (let row = 0; row < BOARD_SIZE; row++) {
        const line = text(view, rankWidget(row));
        if (line !== '') out.push(line);
    }
    return out;
}

function Stat({ label, value }: { label: string; value: number }): React.JSX.Element {
    return (
        <span className="hud__stat">
            <span className="hud__stat-label">{label}</span>
            <b>{value}</b>
        </span>
    );
}
