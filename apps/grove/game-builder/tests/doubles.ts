// The two seams a build box reaches through, and a game small enough to compile in a test.

import { createHash } from 'node:crypto';
import {
    GameId,
    Manifest,
    Task,
    TaskId,
    VersionId,
    type BuildArtifact,
    type TaskStatusUpdate,
    type WorkspaceFile,
    type WorkspacePath,
} from '@grove/api-contract';
import type { Builder } from '../src/consumer.js';
import type { BuildStore } from '../src/store.js';
import type { Tasks, TaskWritten } from '../src/tasks.js';

export const TASK_ID = TaskId.parse('8c2e4a60-5d17-4b93-8f0a-1e6d2c4b7a35');
export const GAME_ID = GameId.parse('9f1c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f');
export const REVISION = 7;

export const CLAIMED: Task = Task.parse({
    taskId: TASK_ID,
    gameId: GAME_ID,
    kind: 'BUILD',
    status: 'IN_PROGRESS',
    manifestRevision: REVISION,
    attempts: 1,
    createdAt: '2026-09-18T09:00:00.000Z',
    updatedAt: '2026-09-18T09:00:01.000Z',
    startedAt: '2026-09-18T09:00:01.000Z',
});

/**
 * A game as the editor saves one: no imports in the source, because the workbench declares the
 * engine as globals and the build is what puts the import back.
 */
export const PLAYER_SOURCE = `export class Walk extends TopDownMovement {
    override walkSpeed = 180;
}

export class Rules extends ServerScript<Game> {
    @onPlayerJoin
    welcome(ctx: Ctx): void {
        const player = ctx.player;
        if (!player) return;
        player.spawn();
        player.setMovement(Walk);
    }
}
`;

/** The same game with one line a `SyncedScript` may not run, which is what the AST pass refuses. */
export const UNDETERMINED_SOURCE = `export class Walk extends TopDownMovement {
    @onUpdate
    drift(): void {
        this.walkSpeed = Math.random() * 100;
    }
}
`;

export function projectJson(): string {
    return JSON.stringify({
        formatVersion: 1,
        projectId: 'leaf-harvest',
        contentHash: 'b'.repeat(64),
        settings: {
            simRate: 30,
            sendRate: 15,
            maxPlayers: 4,
            bounds: { left: -480, right: 480, top: 270, bottom: -270 },
            regions: [],
        },
        assets: [{ id: 'circle', kind: 'texture', url: '/avatar-circle.svg' }],
        templates: [{ id: 'player', visual: { kind: 'sprite', texture: 'circle' }, scripts: [] }],
        entities: [],
        gameScripts: [{ script: 'src/player#Rules' }],
        scriptModules: [
            {
                path: 'src/player.ts',
                scripts: [
                    { id: 'src/player#Walk', export: 'Walk', location: 'synced', host: 'entity' },
                    { id: 'src/player#Rules', export: 'Rules', location: 'server', host: 'game' },
                ],
            },
        ],
    });
}

/** What a build store was told to keep, so a test can read back what a build actually wrote. */
export interface FakeStore extends BuildStore {
    stored: Map<string, Buffer>;
}

/** A bucket behind @grove/api: one frozen manifest, its files, and whatever a build writes. */
export function holding(files: Record<string, string>): FakeStore {
    const manifest: Manifest = Manifest.parse({
        gameId: GAME_ID,
        revision: REVISION,
        files: Object.keys(files)
            .toSorted()
            .map((path): WorkspaceFile => ({
                path: path as WorkspacePath,
                kind: 'source',
                versionId: VersionId.parse('v1'),
                byteLength: Buffer.byteLength(files[path] ?? ''),
                contentType: 'text/typescript',
            })),
    });
    const stored = new Map<string, Buffer>();

    return {
        stored,
        manifest: async (game, revision) =>
            game === GAME_ID && revision === REVISION
                ? { outcome: 'found', value: manifest }
                : { outcome: 'missing' },
        file: async (_game, _revision, path) => {
            const held = files[path];
            return held === undefined
                ? { outcome: 'missing' }
                : { outcome: 'found', value: Buffer.from(held, 'utf8') };
        },
        store: async (game, revision, name, body) => {
            stored.set(name, body);
            const artifact: BuildArtifact = {
                name,
                url: `https://cdn.grove.example/${game}/build/${String(revision)}/${name}`,
                hash: createHash('sha256').update(body).digest('hex'),
                byteLength: body.byteLength,
            };
            return { outcome: 'stored', artifact };
        },
    };
}

/** A store that answers nothing, for the failures that are the fleet's rather than the source's. */
export function silent(): BuildStore {
    return {
        manifest: async () => ({ outcome: 'unavailable' }),
        file: async () => ({ outcome: 'unavailable' }),
        store: async () => ({ outcome: 'unavailable' }),
    };
}

/** A log that keeps what it was told, so a stub that only reports can still be asserted on. */
export function quiet(): Builder['log'] & { lines: { level: string; details: object }[] } {
    const lines: { level: string; details: object }[] = [];
    const at =
        (level: string) =>
        (details: object = {}) => {
            lines.push({ level, details });
        };
    return { lines, info: at('info'), warn: at('warn'), error: at('error') } as never;
}

/** A task seam that records every update and answers each one from `answers`, in order. */
export function writing(...answers: TaskWritten[]): Tasks & { wrote: TaskStatusUpdate[] } {
    const wrote: TaskStatusUpdate[] = [];
    let at = 0;
    return {
        wrote,
        advance: async (_task, update) => {
            wrote.push(update);
            const answer = answers[at] ?? { outcome: 'settled', task: CLAIMED };
            at += 1;
            return answer;
        },
    };
}
