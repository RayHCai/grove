import { useState } from 'react';
import type { GameStats } from './use-game';
import { RateSelect, usePolled } from './use-polled';

export interface NetPanelProps {
    /** Reads the current session stats, or returns `null` before the client exists. */
    read: () => GameStats | null;
    /** What the lifecycle says right now, which a frozen poll must not contradict. */
    state: string;
}

export function NetPanel({ read, state }: NetPanelProps): React.JSX.Element {
    const [rate, setRate] = useState<number>(4);
    const { value: stats } = usePolled<GameStats | null>(read, rate, null);

    return (
        <section className="loop">
            <header className="loop__bar">
                <strong>session</strong>
                <span className="loop__mode">{state}</span>

                <RateSelect label="session poll rate" rate={rate} onChange={setRate} />
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
