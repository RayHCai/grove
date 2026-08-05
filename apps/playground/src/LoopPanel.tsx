// The game-loop panel: a live view of the fixed-step core Loop, sitting beside the render
// tree. Where the Inspector shows WHAT is drawn, this shows the sim driving it — the tick
// count, the fixed timestep, and how much of the next tick is buffered in the accumulator.
//
// POLLED, NOT PER FRAME, for the same reason as the Inspector: reading once a frame would
// couple React's render rate to the sim, which is the coupling this harness avoids. A few
// times a second is faster than anyone reads a counter.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LoopStats } from './game';

/** Poll rates offered in the UI, in Hz. `0` freezes. Mirrors the Inspector's control. */
const RATES = [0, 2, 4, 10] as const;

export interface LoopPanelProps {
    /** Reads the current loop stats, or returns `null` before the game is running. */
    read: () => LoopStats | null;
    /** Pauses / resumes the sim. Debug-only: the render frame keeps running regardless. */
    onSetPaused: (paused: boolean) => void;
}

export function LoopPanel({ read, onSetPaused }: LoopPanelProps): React.JSX.Element {
    const [stats, setStats] = useState<LoopStats | null>(null);
    const [rate, setRate] = useState<number>(10);

    // Read through a ref so a fresh closure each render does not re-arm the interval.
    const readRef = useRef(read);
    readRef.current = read;

    const sample = useCallback(() => setStats(readRef.current()), []);

    useEffect(() => {
        sample();
        if (rate === 0) return;
        const timer = setInterval(sample, 1000 / rate);
        return () => clearInterval(timer);
    }, [rate, sample]);

    // Toggle, then re-sample immediately so the readout flips even when polling is frozen.
    const togglePause = useCallback(() => {
        const current = readRef.current();
        onSetPaused(!(current?.paused ?? false));
        sample();
    }, [onSetPaused, sample]);

    return (
        <section className="loop">
            <header className="loop__bar">
                <strong>game loop</strong>
                {stats !== null && (
                    <span className="loop__mode">
                        {stats.paused ? 'paused' : 'running'} · {stats.simRate} Hz
                    </span>
                )}

                <button
                    type="button"
                    className="loop__pause"
                    onClick={togglePause}
                    disabled={stats === null}
                >
                    {stats?.paused ? 'resume' : 'pause'}
                </button>

                <select
                    aria-label="loop poll rate"
                    value={rate}
                    onChange={(e) => setRate(Number(e.target.value))}
                >
                    {RATES.map((hz) => (
                        <option key={hz} value={hz}>
                            {hz === 0 ? 'frozen' : `${hz}/s`}
                        </option>
                    ))}
                </select>
            </header>

            {stats === null ? (
                <p className="loop__empty">waiting for the game…</p>
            ) : (
                <div className="loop__body">
                    <dl className="loop__grid">
                        <Metric label="tick" value={stats.tick.toLocaleString()} />
                        <Metric label="sim rate" value={`${stats.simRate} Hz`} />
                        <Metric
                            label="fixed dt"
                            value={`${(1000 / stats.simRate).toFixed(2)} ms`}
                        />
                        <Metric label="live" value={String(stats.live)} />
                        <Metric label="ticks / frame" value={String(stats.ticksThisFrame)} />
                    </dl>

                    <div className="loop__heartbeat">
                        <div className="loop__heartbeat-label">
                            accumulator
                            <span>{Math.round(stats.accumulatorFill * 100)}%</span>
                        </div>
                        {/* The sub-tick fill: fills toward one whole tick, then the loop steps
                            and it resets. A live picture of the fixed-step accumulator draining. */}
                        <div
                            className="loop__meter"
                            role="progressbar"
                            aria-label="sub-tick accumulator fill"
                            aria-valuenow={Math.round(stats.accumulatorFill * 100)}
                            aria-valuemin={0}
                            aria-valuemax={100}
                        >
                            <div
                                className={`loop__meter-fill${stats.paused ? ' loop__meter-fill--paused' : ''}`}
                                style={{ width: `${stats.accumulatorFill * 100}%` }}
                            />
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
    return (
        <div className="loop__metric">
            <dt>{label}</dt>
            <dd>{value}</dd>
        </div>
    );
}
