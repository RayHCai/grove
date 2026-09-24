import { useState } from 'react';
import type { IRenderer, NodeId, NodeSnapshot, SceneSnapshot } from '@platform/renderer';
import { NO_NODE } from '@platform/renderer';
import { RateSelect, usePolled } from './use-polled';

export interface InspectorProps {
    /** `null` before the renderer is ready; the panel then shows its empty state. */
    renderer: IRenderer | null;
}

export function Inspector({ renderer }: InspectorProps): React.JSX.Element {
    const [rate, setRate] = useState<number>(4);
    const [selected, setSelected] = useState<NodeId | null>(null);
    // Cheaper than bounds on a big scene, and the flag is what `skipBounds` exists for.
    const [showBounds, setShowBounds] = useState(true);

    const { value: snapshot, resample } = usePolled<SceneSnapshot | null>(
        () => (renderer === null ? null : renderer.inspect({ skipBounds: !showBounds })),
        rate,
        null,
        [renderer, showBounds],
    );

    const node = selected === null ? undefined : snapshot?.nodes.get(selected);
    // A selected node that has since been destroyed: keep the id visible but say it is gone,
    // rather than silently clearing the selection out from under the reader.
    const selectionDied = selected !== null && node === undefined;

    return (
        <section className="inspector">
            <header className="inspector__bar">
                <strong>render tree</strong>
                {snapshot !== null && (
                    <span className="inspector__counts">
                        {snapshot.counts.nodes} nodes · {snapshot.counts.culled} culled ·{' '}
                        {snapshot.counts.assets} assets
                    </span>
                )}

                <label className="inspector__toggle">
                    <input
                        type="checkbox"
                        checked={showBounds}
                        onChange={(e) => setShowBounds(e.target.checked)}
                    />
                    bounds
                </label>

                <RateSelect label="poll rate" rate={rate} onChange={setRate} />
                <button type="button" onClick={resample}>
                    sample
                </button>
            </header>

            {snapshot === null ? (
                <p className="inspector__empty">waiting for the renderer…</p>
            ) : (
                <div className="inspector__body">
                    <div className="inspector__tree">
                        {snapshot.surfaces.map(({ surface, visible }) => {
                            const roots = snapshot.roots[surface] ?? [];
                            return (
                                <div key={surface} className="surface">
                                    <div
                                        className={`surface__name${visible ? '' : ' surface__name--hidden'}`}
                                    >
                                        {surface}
                                        <span className="surface__meta">
                                            {roots.length} root{roots.length === 1 ? '' : 's'}
                                            {visible ? '' : ' · hidden'}
                                        </span>
                                    </div>
                                    {roots.length === 0 ? (
                                        <div className="tree__empty">—</div>
                                    ) : (
                                        <ul className="tree">
                                            {roots.map((id) => (
                                                <TreeNode
                                                    key={id}
                                                    id={id}
                                                    snapshot={snapshot}
                                                    depth={0}
                                                    selected={selected}
                                                    onSelect={setSelected}
                                                />
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    <div className="inspector__detail">
                        {selectionDied ? (
                            <p className="inspector__empty">node {selected} was destroyed</p>
                        ) : node === undefined ? (
                            <p className="inspector__empty">select a node</p>
                        ) : (
                            <NodeDetail node={node} />
                        )}
                        <ViewDetail snapshot={snapshot} />
                    </div>
                </div>
            )}
        </section>
    );
}

interface TreeNodeProps {
    id: NodeId;
    snapshot: SceneSnapshot;
    depth: number;
    selected: NodeId | null;
    onSelect: (id: NodeId) => void;
}

/** One row plus its subtree. A cycle is impossible — the core rejects one — so no visited set. */
function TreeNode({ id, snapshot, depth, selected, onSelect }: TreeNodeProps): React.JSX.Element {
    const node = snapshot.nodes.get(id);
    if (node === undefined) return <li className="tree__row tree__row--stale">{id} (missing)</li>;

    const classes = [
        'tree__row',
        selected === id ? 'tree__row--selected' : '',
        node.culled ? 'tree__row--culled' : '',
        node.missingTexture ? 'tree__row--missing' : '',
        node.resolved.visible ? '' : 'tree__row--invisible',
    ]
        .filter(Boolean)
        .join(' ');

    return (
        <li>
            <button
                type="button"
                className={classes}
                style={{ paddingLeft: `${depth * 14 + 8}px` }}
                onClick={() => onSelect(id)}
            >
                <span className={`kind kind--${node.kind}`}>{node.kind}</span>
                <span className="tree__label">
                    {node.kind === 'text'
                        ? `“${truncate(node.text)}”`
                        : node.texture === ''
                          ? '—'
                          : node.texture}
                </span>
                <span className="tree__pos">
                    {round(node.resolved.position.x)}, {round(node.resolved.position.y)}
                </span>
                <span className="tree__flags">
                    {node.layer !== 0 && <span title="layer">L{node.layer}</span>}
                    {node.culled && <span title="outside the expanded viewport">cull</span>}
                    {node.missingTexture && <span title="texture not resident">no-tex</span>}
                    {!node.resolved.visible && <span title="resolved invisible">hidden</span>}
                </span>
            </button>

            {node.children.length > 0 && (
                <ul className="tree">
                    {node.children.map((child) => (
                        <TreeNode
                            key={child}
                            id={child}
                            snapshot={snapshot}
                            depth={depth + 1}
                            selected={selected}
                            onSelect={onSelect}
                        />
                    ))}
                </ul>
            )}
        </li>
    );
}

function NodeDetail({ node }: { node: NodeSnapshot }): React.JSX.Element {
    return (
        <dl className="detail">
            <Row label="id" value={String(node.id)} />
            <Row label="kind" value={node.kind} />
            <Row label="surface" value={node.surface} />
            <Row label="layer" value={String(node.layer)} />
            {node.kind === 'sprite' && (
                <Row
                    label="texture"
                    value={node.texture + (node.missingTexture ? '  (not resident)' : '')}
                />
            )}
            {node.kind === 'text' && <Row label="text" value={node.text} />}
            {node.uiAnchor !== undefined && <Row label="uiAnchor" value={node.uiAnchor} />}
            <Row
                label="parent"
                value={node.parent === NO_NODE ? '— (root)' : String(node.parent)}
            />
            <Row
                label="children"
                value={node.children.length === 0 ? '—' : String(node.children.length)}
            />

            <Row label="local pos" value={vec(node.local.position)} />
            <Row label="resolved pos" value={vec(node.resolved.position)} />
            <Row label="rotation" value={`${round(node.local.rotation)}°`} />
            <Row label="scale" value={vec(node.local.scale)} />
            <Row label="alpha" value={round(node.local.alpha, 2)} />
            <Row
                label="visible"
                value={`${node.local.visible}${
                    node.local.visible === node.resolved.visible
                        ? ''
                        : ` (resolved ${node.resolved.visible})`
                }`}
            />
            <Row label="culled" value={String(node.culled)} />
            {node.localBounds !== null && (
                <Row label="local bounds" value={rect(node.localBounds)} />
            )}
            {node.worldBounds !== null && (
                <Row label="world bounds" value={rect(node.worldBounds)} />
            )}
        </dl>
    );
}

function ViewDetail({ snapshot }: { snapshot: SceneSnapshot }): React.JSX.Element {
    return (
        <dl className="detail detail--view">
            <Row
                label="camera"
                value={`${vec(snapshot.camera.position)} · zoom ${round(snapshot.camera.zoom, 2)} · ${
                    snapshot.camera.framing ?? 'stage'
                }`}
            />
            <Row
                label="canvas"
                value={`${round(snapshot.canvas.width)}x${round(snapshot.canvas.height)} @ ${round(
                    snapshot.resolution,
                    2,
                )}x`}
            />
            <Row label="viewport" value={rect(snapshot.viewport)} />
            <Row label="stage" value={rect(snapshot.stageRect)} />
            <Row label="context" value={snapshot.contextState} />
            <Row
                label="assets"
                value={
                    snapshot.assets.length === 0
                        ? '—'
                        : snapshot.assets
                              .map(
                                  (a) => `${a.name} ${round(a.size.width)}x${round(a.size.height)}`,
                              )
                              .join(', ')
                }
            />
        </dl>
    );
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
    return (
        <>
            <dt>{label}</dt>
            <dd>{value}</dd>
        </>
    );
}

/** Fixed decimals without trailing zeros — `1.5` not `1.50`, `12` not `12.00`. */
function round(value: number, places = 1): string {
    if (!Number.isFinite(value)) return String(value);
    return String(Number(value.toFixed(places)));
}

function vec(v: { x: number; y: number; z?: number }): string {
    return `${round(v.x)}, ${round(v.y)}`;
}

function rect(r: { left: number; right: number; top: number; bottom: number }): string {
    return `l ${round(r.left)} r ${round(r.right)} t ${round(r.top)} b ${round(r.bottom)}`;
}

function truncate(text: string, max = 18): string {
    return text.length <= max ? text : `${text.slice(0, max)}…`;
}
