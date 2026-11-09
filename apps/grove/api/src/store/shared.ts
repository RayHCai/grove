import { createHash } from 'node:crypto';
import {
    FileKind,
    GameId,
    GameVisibility,
    MediaType,
    PlayerId,
    Task,
    VersionId,
    WorkspacePath,
    type WorkspaceFile,
} from '@grove/api-contract';
import type { GameRecord, WorkspaceRecord } from '../records.js';
import type { Game, Task as TaskRow } from '../generated/prisma/client.js';

/** Postgres refused a write because a unique index already held the value. */
export const UNIQUE_VIOLATION = 'P2002';
/** Postgres refused a delete because a row still points at it. */
export const FOREIGN_KEY_VIOLATION = 'P2003';
/** The row a write named was not there to write. */
export const RECORD_NOT_FOUND = 'P2025';

/** The set a task is live in, which is the set the partial unique index is built over. */
export const LIVE = ['NOT_STARTED', 'IN_PROGRESS'] as const;

export function codeOf(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : undefined;
}

/** SHA-256 in its own ArrayBuffer, since Prisma types `Bytes` as one and a Buffer is a view. */
export function digest(secret: string): Uint8Array<ArrayBuffer> {
    const hashed = createHash('sha256').update(secret).digest();
    const bytes = new Uint8Array(new ArrayBuffer(hashed.byteLength));
    bytes.set(hashed);
    return bytes;
}

/** Prisma hands back plain strings; parsing is what proves the column holds a wire-legal id. */
export function asGame(row: Game): GameRecord {
    return {
        gameId: GameId.parse(row.id),
        ownerId: PlayerId.parse(row.ownerId),
        title: row.title,
        visibility: GameVisibility.parse(row.visibility),
        createdAt: row.createdAt.toISOString(),
        publishedAt: row.publishedAt?.toISOString() ?? null,
    };
}

export interface FileRow {
    path: string;
    kind: string;
    versionId: string;
    byteLength: number;
    contentType: string;
}

/** Parsed, not cast: a version no bucket answers for is a build failing minutes later. */
export function asFile(row: FileRow): WorkspaceFile {
    return {
        path: WorkspacePath.parse(row.path),
        kind: FileKind.parse(row.kind),
        versionId: VersionId.parse(row.versionId),
        byteLength: row.byteLength,
        contentType: MediaType.parse(row.contentType),
    };
}

export const FILE_SELECT = {
    path: true,
    kind: true,
    versionId: true,
    byteLength: true,
    contentType: true,
} as const;

export const WORKSPACE_SELECT = {
    id: true,
    draftRevision: true,
    draftSaveId: true,
    updatedAt: true,
    // Path order, so two reads of one revision are the same bytes whatever the planner chose.
    files: { select: FILE_SELECT, orderBy: { path: 'asc' } },
} as const;

export interface WorkspaceRow {
    id: string;
    draftRevision: number;
    draftSaveId: string | null;
    updatedAt: Date;
    files: FileRow[];
}

export function asWorkspace(row: WorkspaceRow): WorkspaceRecord {
    return {
        gameId: GameId.parse(row.id),
        revision: row.draftRevision,
        saveId: row.draftSaveId ?? undefined,
        files: row.files.map(asFile),
        updatedAt: row.updatedAt.toISOString(),
    };
}

/** An optional column reaches the wire shape by being absent, never by being null. */
export function asTask(row: TaskRow): Task {
    return Task.parse({
        taskId: row.id,
        gameId: row.gameId,
        kind: row.kind,
        status: row.status,
        manifestRevision: row.manifestRevision,
        ...(row.assetPath === null ? {} : { assetPath: row.assetPath }),
        attempts: row.attempts,
        ...(row.detail === null ? {} : { detail: row.detail }),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        ...(row.startedAt === null ? {} : { startedAt: row.startedAt.toISOString() }),
        ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt.toISOString() }),
    });
}
