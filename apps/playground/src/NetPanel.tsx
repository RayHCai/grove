// The session panel: a live view of this tab's connection to the authority, beside the render tree.
//
// Where the Inspector shows WHAT is drawn, this shows where it came from — the tick the server has
// depicted, the tick this client stamps input with, the round trip between them, and the lead the
// clock is holding to land input on time.
//
// POLLED, NOT PER FRAME, for the same reason as the Inspector: `stats()` allocates and the client
// publishes no change event, so reading it per frame would couple React's render rate to the wire.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameStats } from './use-game';

/** Poll rates offered in the UI, in Hz. `0` freezes. Mirrors the Inspector's control. */
const RATES = [0, 2, 4, 10] as const;

export interface NetPanelProps {
    /** Reads the current session stats, or returns `null` before the client exists. */
    read: () => GameStats | null;
    /** What the lifecycle says right now, which a frozen poll must not contradict. */
    state: string;
}

export function NetPanel({ read, state }: NetPanelProps): React.JSX.Element {
    const [stats, setStats] = useState<GameStats | null>(null);
    const [rate, setRate] = useState<number>(4);

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

    return (
        <section className="loop">
            <header className="loop__bar">
                <strong>session</strong>
                <span className="loop__mode">{state}</span>

                <select
                    aria-label="session poll rate"
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
                <p className="loop__empty">waiting for the server…</p>
            ) : (
                <div className="loop__body">
                    <dl className="loop__grid">
                        <Metric label="depicted tick" value={stats.depictedTick.toLocaleString()} />
                        <Metric label="local tick" value={stats.localTick.toLocaleString()} />
                        <Metric label="rtt" value={`${Math.round(stats.rttSeconds * 1000)} ms`} />
                        <Metric
                            label="lead"
                            value={`${Math.round(stats.currentLeadSeconds * 1000)} ms`}
                        />
                        <Metric label="unacked input" value={String(stats.ringSize)} />
                        <Metric label="nodes" value={String(stats.nodeCount)} />
                        <Metric label="fps" value={String(stats.fps)} />
                    </dl>

                    {/* The predicted half. `predicted tick` leads `depicted` by the span being
                        replayed, one resimulation happens per frame that carried state, and
                        `attach skipped` counts the server-located scripts this page was told about
                        and correctly holds no class for — it is a census, not a fault. */}
                    <dl className="loop__grid">
                        <Metric
                            label="predicted tick"
                            value={stats.predictedTick.toLocaleString()}
                        />
                        <Metric
                            label="resimulations"
                            value={stats.resimulations.toLocaleString()}
                        />
                        <Metric label="snapped" value={String(stats.snappedCorrections)} />
                        <Metric label="attach skipped" value={String(stats.droppedAttach)} />
                    </dl>

                    {/* Silent-by-design failures: a nonzero count here is why art is missing or an
                        entity never appeared, and nothing else in the UI would say so. */}
                    {(stats.assetLoadFailed > 0 ||
                        stats.unknownNetId > 0 ||
                        stats.droppedToOverflow > 0 ||
                        stats.oversizedList > 0 ||
                        stats.invalidNetId > 0 ||
                        stats.cappedReplays > 0) && (
                        <dl className="loop__grid">
                            <Metric label="assets failed" value={String(stats.assetLoadFailed)} />
                            <Metric label="unknown netId" value={String(stats.unknownNetId)} />
                            <Metric label="input dropped" value={String(stats.droppedToOverflow)} />
                            <Metric label="oversized list" value={String(stats.oversizedList)} />
                            <Metric label="invalid netId" value={String(stats.invalidNetId)} />
                            <Metric label="capped replays" value={String(stats.cappedReplays)} />
                        </dl>
                    )}
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
