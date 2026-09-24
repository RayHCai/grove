import type {
    FileKind,
    FleetReport,
    GameId,
    GameVisibility,
    MediaType,
    PlayableVersion,
    PlayerId,
    PublishedVersion,
    Task,
    TaskId,
    TaskKind,
    TaskStatusUpdate,
    VersionId,
    WorkspaceFile,
    WorkspacePath,
} from '@grove/api-contract';

/** An account as its owner sees it; never the password hash — no column of it reaches here. */
export interface AccountRecord {
    playerId: PlayerId;
    email: string;
    displayName: string;
    createdAt: string;
}

/** An account as anyone else sees it: a name to render, and the id it belongs to. */
export interface Profile {
    playerId: PlayerId;
    displayName: string;
}

export interface GameRecord {
    gameId: GameId;
    ownerId: PlayerId;
    title: string;
    visibility: GameVisibility;
    createdAt: string;
}

/** Only `created` names an account; `taken` is one address already answering to somebody. */
export type AccountCreated =
    | { outcome: 'created'; account: AccountRecord }
    | { outcome: 'taken' }
    | { outcome: 'unattached' };

/** A game's files as they stand, and the revision that names this exact set. */
export interface WorkspaceRecord {
    gameId: GameId;
    revision: number;
    files: WorkspaceFile[];
    updatedAt: string;
}

/** One path a save is writing, carrying the version the bucket minted for its bytes. */
export interface FileUpsert {
    path: WorkspacePath;
    kind: FileKind;
    versionId: VersionId;
    byteLength: number;
    contentType: MediaType;
}

/**
 * What one save changes, with the bytes already in the bucket. `freeze` runs inside the
 * transaction claiming the revision, so an unwritable manifest is a save that did not happen.
 */
export interface SavePlan {
    baseRevision: number;
    /** Who asked, which is who an asset's task is billed to. */
    accountId: PlayerId;
    upserts: FileUpsert[];
    deletes: WorkspacePath[];
    freeze(revision: number, files: WorkspaceFile[]): Promise<boolean>;
}

/**
 * `stale` carries the set that was there instead, so an editor that lost the race needs no
 * second round trip. `unfrozen` is a manifest the bucket refused, which rolls the save back.
 */
export type WorkspaceSaved =
    | { outcome: 'saved'; workspace: WorkspaceRecord; tasks: Task[] }
    | { outcome: 'stale'; workspace: WorkspaceRecord }
    | { outcome: 'missing' }
    | { outcome: 'unfrozen' };

/** `existing` is the non-terminal task that was already queued for this exact manifest. */
export type TaskQueued =
    | { outcome: 'queued'; task: Task }
    | { outcome: 'existing'; task: Task }
    | { outcome: 'missing' }
    | { outcome: 'unattached' };

/**
 * `backwards` is a redelivered attempt trying to walk a settled task back, which is refused rather
 * than applied — it carries the task as it stands so the caller can stop rather than retry.
 */
export type TaskAdvanced =
    | { outcome: 'advanced'; task: Task }
    | { outcome: 'backwards'; task: Task }
    | { outcome: 'missing' };

export type GameCreated = { outcome: 'created'; game: GameRecord } | { outcome: 'unattached' };

export type GameUpdated =
    { outcome: 'updated'; game: GameRecord } | { outcome: 'missing' } | { outcome: 'unattached' };

/** `wrong_password` covers a missing one: a caller who cannot re-authenticate may not proceed. */
export type Reauthed =
    { outcome: 'ok' } | { outcome: 'wrong_password' } | { outcome: 'unattached' };

/** Every write names the seam when nothing is behind it, so a deploy that forgot the database says
 * so rather than telling a creator their account is gone. */
export type AccountRenamed =
    | { outcome: 'renamed'; account: AccountRecord }
    | { outcome: 'missing' }
    | { outcome: 'unattached' };

/**
 * A reset key was minted and here is the secret to mail. `no_account` never reaches the wire:
 * which addresses have accounts is what an unauthenticated caller must not be able to ask.
 */
export type ResetBegun =
    | { outcome: 'begun'; email: string; token: string }
    | { outcome: 'no_account' }
    | { outcome: 'unattached' };

/** `refused` is a key that was wrong, already spent, or past its hour — one answer for all. */
export type ResetFinished =
    { outcome: 'reset'; player: PlayerId } | { outcome: 'refused' } | { outcome: 'unattached' };

/** `owns_games` is the one refusal with a cause a caller can act on, and not a bad password. */
export type AccountClosed =
    | { outcome: 'closed' }
    | { outcome: 'wrong_password' }
    | { outcome: 'owns_games' }
    | { outcome: 'unattached' };

/**
 * The durable answers a route needs, and every write that makes them true. Handed to `buildApp`,
 * so the store is one dependency; every failure is a union member rather than a thrown error.
 */
export interface Records {
    signIn(email: string, password: string): Promise<PlayerId | undefined>;
    ownerOf(game: GameId): Promise<PlayerId | undefined>;

    createAccount(email: string, password: string, displayName: string): Promise<AccountCreated>;
    accountOf(player: PlayerId): Promise<AccountRecord | undefined>;
    profileOf(player: PlayerId): Promise<Profile | undefined>;
    renameAccount(player: PlayerId, displayName: string): Promise<AccountRenamed>;
    changePassword(player: PlayerId, current: string, next: string): Promise<Reauthed>;
    closeAccount(player: PlayerId, current: string): Promise<AccountClosed>;

    beginPasswordReset(email: string): Promise<ResetBegun>;
    finishPasswordReset(token: string, next: string): Promise<ResetFinished>;

    createGame(owner: PlayerId, title: string): Promise<GameCreated>;
    gamesOf(owner: PlayerId): Promise<GameRecord[]>;
    /** One game as the allocator reads it, which is the only read there that is not the owner's. */
    gameOf(game: GameId): Promise<GameRecord | undefined>;
    setVisibility(game: GameId, visibility: GameVisibility): Promise<GameUpdated>;

    workspaceOf(game: GameId): Promise<WorkspaceRecord | undefined>;
    /** One file as the rows name it, which is what a read is allowed to fetch by. */
    fileOf(game: GameId, path: WorkspacePath): Promise<WorkspaceFile | undefined>;
    saveWorkspace(game: GameId, plan: SavePlan): Promise<WorkspaceSaved>;
    /**
     * The assets of this game whose verification has not reached the bytes they hold, at most
     * `limit` of them. Empty is the only state a build may be queued from.
     *
     * Named rather than counted, because a creator told a publish was refused has to be told which
     * file to look at — and a path the editor can highlight is the difference between waiting and
     * knowing what to re-upload.
     */
    unvalidatedAssets(game: GameId, limit: number): Promise<WorkspacePath[]>;
    publishedVersionOf(game: GameId): Promise<PublishedVersion | undefined>;
    /**
     * The newest version anybody can play: the highest revision whose build finished.
     * Different from `publishedVersionOf`, which answers what a publish last ASKED for.
     */
    playableVersionOf(game: GameId): Promise<PlayableVersion | undefined>;
    markPublished(game: GameId, version: PublishedVersion): Promise<void>;

    /** Returns the live task for this exact manifest rather than creating a second one. */
    queueTask(
        game: GameId,
        account: PlayerId,
        kind: TaskKind,
        manifestRevision: number,
    ): Promise<TaskQueued>;
    taskOf(game: GameId, task: TaskId): Promise<Task | undefined>;
    advanceTask(task: TaskId, update: TaskStatusUpdate): Promise<TaskAdvanced>;
    /** What the sweeper reads: one kind, still unclaimed, queued before a cutoff. */
    unclaimedTasks(kind: TaskKind, before: Date, limit: number): Promise<Task[]>;

    /**
     * Records what @grove/server-manager last saw of the fleet. Hosts are a snapshot; events are
     * append-only and keyed by the router's own id, so a retried report rewrites its own rows.
     */
    recordFleet(report: FleetReport): Promise<void>;
}

/** The records seam with nothing behind it: the accounts, games and tasks tables land here. */
export const unattachedRecords: Records = {
    // Answering nothing rather than throwing: with no store attached nobody holds an account and
    // nobody owns a game, which the routes already turn into a 401, a 403 and an empty list.
    signIn: async () => undefined,
    ownerOf: async () => undefined,
    accountOf: async () => undefined,
    profileOf: async () => undefined,
    gamesOf: async () => [],

    // A write has no such answer, so it names the seam instead and the route turns that into a 501
    // beside the one the publish route already answers with no build pipeline attached.
    createAccount: async () => ({ outcome: 'unattached' }),
    renameAccount: async () => ({ outcome: 'unattached' }),
    changePassword: async () => ({ outcome: 'unattached' }),
    closeAccount: async () => ({ outcome: 'unattached' }),
    beginPasswordReset: async () => ({ outcome: 'unattached' }),
    finishPasswordReset: async () => ({ outcome: 'unattached' }),
    createGame: async () => ({ outcome: 'unattached' }),
    setVisibility: async () => ({ outcome: 'unattached' }),
    queueTask: async () => ({ outcome: 'unattached' }),

    // A game-scoped read needs no seam of its own to name: `ownerOf` already answered nobody, so
    // `requireGameOwner` refused every route below before one of these could be reached.
    gameOf: async () => undefined,
    workspaceOf: async () => undefined,
    fileOf: async () => undefined,
    publishedVersionOf: async () => undefined,
    playableVersionOf: async () => undefined,
    taskOf: async () => undefined,
    // Empty is what a game with no files holds, and a game with no files is what every read above
    // just answered: the gate this feeds is open because there is nothing behind it to verify.
    unvalidatedAssets: async () => [],
    saveWorkspace: async () => ({ outcome: 'missing' }),
    advanceTask: async () => ({ outcome: 'missing' }),
    markPublished: async () => undefined,
    unclaimedTasks: async () => [],

    // The fleet reporting into a service with no store behind it: the router keeps routing off its
    // own registry, and only the history it was handing over is dropped.
    recordFleet: async () => {},
};
