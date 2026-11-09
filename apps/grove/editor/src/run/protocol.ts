// The one channel between the editor and a run's sandboxed document, read on both sides.

import type { ProjectManifest } from '@platform/project';

/** What every message on the channel is tagged with, so a stray message is never read as one. */
export const CHANNEL = 'grove-preview';

/** The query parameter a run's document is opened with, which every message then carries. */
export const RUN_PARAM = 'run';

export type LogLevel = 'log' | 'warn' | 'error';

/** Where a run's stage has got to, which the play pane says while the world is coming up. */
export type StageStatus = 'starting' | 'running' | 'failed';

/** The ground a run's own document is drawn on; it cannot read the editor's stylesheet. */
export interface StageColors {
    background: string;
    foreground: string;
}

/** A program of plain TypeScript: a module graph and the module it starts at. */
export interface PlainRun {
    mode: 'plain';
    modules: Record<string, string>;
    entry: string;
    title: string;
    colors: StageColors;
}

/** A file of the editor's own the world's manifest names, handed over since the frame can fetch none. */
export interface ServedAsset {
    url: string;
    contentType: string;
    bytes: ArrayBuffer;
}

/** A world: its module graph, the manifest it boots from, and who is joining it. */
export interface WorldRun {
    mode: 'world';
    modules: Record<string, string>;
    project: ProjectManifest;
    name: string;
    colors: StageColors;
    assets: readonly ServedAsset[];
}

export type Game = PlainRun | WorldRun;

export type ToFrame = { type: 'run'; game: Game } | { type: 'pause' } | { type: 'resume' };

export type FromFrame =
    | { type: 'ready' }
    | { type: 'line'; level: LogLevel; text: string }
    | { type: 'status'; status: StageStatus };

/** A message as it crosses: the channel, the run it belongs to, and what it says. */
export type Envelope<T> = T & { channel: typeof CHANNEL; run: string };

const LEVELS: ReadonlySet<string> = new Set(['log', 'warn', 'error']);
const STATUSES: ReadonlySet<string> = new Set(['starting', 'running', 'failed']);

function addressed(data: unknown, run: string): data is Record<string, unknown> {
    if (typeof data !== 'object' || data === null) return false;
    const held = data as Record<string, unknown>;
    return held['channel'] === CHANNEL && held['run'] === run;
}

/** What a run's document said, or nothing for a message this run did not send. */
export function fromFrame(data: unknown, run: string): FromFrame | undefined {
    if (!addressed(data, run)) return undefined;
    if (data['type'] === 'ready') return { type: 'ready' };
    if (data['type'] === 'line' && typeof data['text'] === 'string') {
        const level =
            typeof data['level'] === 'string' && LEVELS.has(data['level']) ? data['level'] : 'log';
        return { type: 'line', level: level as LogLevel, text: data['text'] };
    }
    if (
        data['type'] === 'status' &&
        typeof data['status'] === 'string' &&
        STATUSES.has(data['status'])
    ) {
        return { type: 'status', status: data['status'] as StageStatus };
    }
    return undefined;
}

/** What the editor told a run's document, or nothing for a message it did not send this run. */
export function toFrame(data: unknown, run: string): ToFrame | undefined {
    if (!addressed(data, run)) return undefined;
    if (data['type'] === 'pause' || data['type'] === 'resume') return { type: data['type'] };
    if (data['type'] === 'run' && typeof data['game'] === 'object' && data['game'] !== null) {
        return { type: 'run', game: data['game'] as Game };
    }
    return undefined;
}
