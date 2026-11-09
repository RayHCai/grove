import type {
    Account,
    BuildArtifact,
    FileKind,
    FleetReport,
    Game,
    GameId,
    GameVisibility,
    MediaType,
    PlayableVersion,
    PlayerId,
    Profile,
    PublishedVersion,
    Task,
    TaskId,
    TaskKind,
    TaskStatusUpdate,
    VersionId,
    WorkspaceFile,
    WorkspacePath,
} from '@grove/api-contract';

/** An account as its owner sees it; never the password hash, since no column of it reaches here. */
export type AccountRecord = Account;

export type GameRecord = Game;

/** Only `created` names an account; `taken` is one address already answering to somebody. */
export type AccountCreated =
    | { outcome: 'created'; account: AccountRecord }
    | { outcome: 'taken' }
    | { outcome: 'unattached' };

/** `wrong_password` covers a missing one: a caller who cannot re-authenticate may not proceed. */
export type Reauthed =
    { outcome: 'ok' } | { outcome: 'wrong_password' } | { outcome: 'unattached' };

/** Every write names the seam when nothing is behind it, so a missing database is said outright. */
export type AccountRenamed =
    | { outcome: 'renamed'; account: AccountRecord }
    | { outcome: 'missing' }
    | { outcome: 'unattached' };

/** Neither `no_account` nor `throttled` reaches the wire: which addresses exist is secret. */
export type ResetBegun =
    | { outcome: 'begun'; email: string; token: string }
    | { outcome: 'throttled' }
    | { outcome: 'no_account' }
    | { outcome: 'unattached' };

/** `refused` is a key that was wrong, already spent, or past its hour: one answer for all. */
export type ResetFinished =
    { outcome: 'reset'; player: PlayerId } | { outcome: 'refused' } | { outcome: 'unattached' };

/** `owns_games` is the one refusal with a cause a caller can act on, and not a bad password. */
export type AccountClosed =
    | { outcome: 'closed' }
    | { outcome: 'wrong_password' }
    | { outcome: 'owns_games' }
    | { outcome: 'unattached' };

/** Who holds an account, and every write a credential or a forgotten password makes. */
export interface Accounts {
    signIn(email: string, password: string): Promise<PlayerId | undefined>;
    createAccount(email: string, password: string, displayName: string): Promise<AccountCreated>;
    accountOf(player: PlayerId): Promise<AccountRecord | undefined>;
    profileOf(player: PlayerId): Promise<Profile | undefined>;
    renameAccount(player: PlayerId, displayName: string): Promise<AccountRenamed>;
    changePassword(player: PlayerId, current: string, next: string): Promise<Reauthed>;
    closeAccount(player: PlayerId, current: string): Promise<AccountClosed>;
    beginPasswordReset(email: string): Promise<ResetBegun>;
    finishPasswordReset(token: string, next: string): Promise<ResetFinished>;
}

export type GameCreated = { outcome: 'created'; game: GameRecord } | { outcome: 'unattached' };

export type GameUpdated =
    { outcome: 'updated'; game: GameRecord } | { outcome: 'missing' } | { outcome: 'unattached' };

export type GameDeleted =
    { outcome: 'deleted' } | { outcome: 'missing' } | { outcome: 'unattached' };

/** Where one page of a listing stopped: the newest-first order is by creation, then by id. */
export interface GameCursor {
    createdAt: string;
    gameId: GameId;
}

export interface GamePage {
    games: GameRecord[];
    next: GameCursor | undefined;
}

/** A game as a row: who owns it, who may reach it, and what was last published of it. */
export interface Games {
    ownerOf(game: GameId): Promise<PlayerId | undefined>;
    createGame(owner: PlayerId, title: string): Promise<GameCreated>;
    gamesOf(owner: PlayerId, limit: number, after?: GameCursor): Promise<GamePage>;
    gameOf(game: GameId): Promise<GameRecord | undefined>;
    setVisibility(game: GameId, visibility: GameVisibility): Promise<GameUpdated>;
    /** Drops the game's row, and with it (by cascade) its files and tasks. The bucket is the caller's. */
    deleteGame(game: GameId): Promise<GameDeleted>;
    publishedVersionOf(game: GameId): Promise<PublishedVersion | undefined>;
    markPublished(game: GameId, version: PublishedVersion): Promise<void>;
}

/** A game's files as they stand, and the revision (and the save that froze it) naming this set. */
export interface WorkspaceRecord {
    gameId: GameId;
    revision: number;
    saveId: string | undefined;
    files: WorkspaceFile[];
    updatedAt: string;
}

/** One file as a read needs it: an inspected asset is served from its edge copy, not its upload. */
export interface HeldFile extends WorkspaceFile {
    edgeVersionId: VersionId | undefined;
}

/** One path a save is writing, carrying the version the bucket minted for its bytes. */
export interface FileUpsert {
    path: WorkspacePath;
    kind: FileKind;
    versionId: VersionId;
    byteLength: number;
    contentType: MediaType;
}

/** A save whose bytes, manifest included, are already in the bucket under `saveId`. */
export interface SavePlan {
    baseRevision: number;
    saveId: string;
    /** Who asked, which is who an asset's task is billed to. */
    accountId: PlayerId;
    upserts: FileUpsert[];
    deletes: WorkspacePath[];
    /** The set that manifest froze, which the rows have to come to equal or the save is stale. */
    frozen: WorkspaceFile[];
}

/** `stale` carries the set that was there instead, so a loser of the race needs no second read. */
export type WorkspaceSaved =
    | { outcome: 'saved'; workspace: WorkspaceRecord; tasks: Task[] }
    | { outcome: 'stale'; workspace: WorkspaceRecord }
    | { outcome: 'missing' };

/** The files a game is authored from, and the save that moves them on. */
export interface Workspaces {
    workspaceOf(game: GameId): Promise<WorkspaceRecord | undefined>;
    fileOf(game: GameId, path: WorkspacePath): Promise<HeldFile | undefined>;
    saveWorkspace(game: GameId, plan: SavePlan): Promise<WorkspaceSaved>;
}

/** `unverified` names the assets holding a build back; `moved` is a revision saved over since. */
export type BuildQueued =
    | { outcome: 'queued'; task: Task }
    | { outcome: 'existing'; task: Task }
    | { outcome: 'unverified'; paths: WorkspacePath[] }
    | { outcome: 'moved' }
    | { outcome: 'missing' }
    | { outcome: 'unattached' };

/** Who is claiming, for which kind of work, and how long nobody else may. */
export interface Claim {
    kind: TaskKind;
    worker: string;
    leaseMs: number;
}

/** `held` is another worker's live lease; `settled` is work somebody already finished. */
export type TaskClaimed =
    | { outcome: 'claimed'; task: Task; leaseUntil: Date }
    | { outcome: 'held'; task: Task }
    | { outcome: 'settled'; task: Task }
    | { outcome: 'missing' };

/** The upload an asset task inspects, while the game still holds it. */
export interface HeldUpload {
    gameId: GameId;
    path: WorkspacePath;
    versionId: VersionId;
    byteLength: number;
    contentType: string;
}

/** `validated` is whether the asset row took the verdict, which a superseded upload does not. */
export type TaskSettled =
    | { outcome: 'settled'; task: Task; validated: boolean }
    | { outcome: 'refused'; task: Task }
    | { outcome: 'missing' };

/** A build task as the routes a builder reads and writes through need it. */
export interface BuildWork {
    taskId: TaskId;
    gameId: GameId;
    revision: number;
    saveId: string | undefined;
    live: boolean;
}

/** The queued work of every kind, its leases, and what a build stored. */
export interface Tasks {
    /** Queues a build of exactly `revision`, refused while one of its assets is unverified. */
    queueBuild(
        game: GameId,
        account: PlayerId,
        revision: number,
        saveId: string | undefined,
    ): Promise<BuildQueued>;
    taskOf(game: GameId, task: TaskId): Promise<Task | undefined>;
    claimTask(task: TaskId, claim: Claim): Promise<TaskClaimed>;
    uploadOf(task: TaskId): Promise<HeldUpload | undefined>;
    /** `edgeVersionId` is the inspected copy a successful upload settles with. */
    settleTask(
        task: TaskId,
        kind: TaskKind,
        update: TaskStatusUpdate,
        edgeVersionId?: VersionId,
    ): Promise<TaskSettled>;
    buildOf(task: TaskId): Promise<BuildWork | undefined>;
    recordArtifact(task: TaskId, artifact: BuildArtifact): Promise<void>;
    artifactsOf(task: TaskId): Promise<BuildArtifact[]>;
    /** The highest revision whose build finished, the latest finish breaking a tie. */
    playableVersionOf(game: GameId): Promise<PlayableVersion | undefined>;
    /** Unclaimed or lapsed work of one kind that nothing has announced since `before`. */
    dueForAnnouncement(kind: TaskKind, before: Date, now: Date, limit: number): Promise<TaskId[]>;
    markAnnounced(tasks: readonly TaskId[], at: Date): Promise<void>;
    /** Fails each claim of one kind whose lease ran out before `before`: nobody came back. */
    reapAbandoned(kind: TaskKind, before: Date, message: string): Promise<TaskId[]>;
}

/** What @grove/server-manager last saw: hosts as a snapshot, events keyed by its own id. */
export interface FleetHistory {
    recordFleet(report: FleetReport): Promise<void>;
}

/** Every record seam, which `main.ts` attaches together and `buildApp` hands out one at a time. */
export interface Stores {
    accounts: Accounts;
    games: Games;
    workspaces: Workspaces;
    tasks: Tasks;
    fleetHistory: FleetHistory;
}

// Answering nothing rather than throwing: with no store attached nobody holds an account, which the
// routes already turn into a 401, and every write names the seam so it becomes a 501.
export const unattachedAccounts: Accounts = {
    signIn: async () => undefined,
    accountOf: async () => undefined,
    profileOf: async () => undefined,
    createAccount: async () => ({ outcome: 'unattached' }),
    renameAccount: async () => ({ outcome: 'unattached' }),
    changePassword: async () => ({ outcome: 'unattached' }),
    closeAccount: async () => ({ outcome: 'unattached' }),
    beginPasswordReset: async () => ({ outcome: 'unattached' }),
    finishPasswordReset: async () => ({ outcome: 'unattached' }),
};

// Nobody owns a game, so `requireGameOwner` refuses every game-scoped route before a read lands.
export const unattachedGames: Games = {
    ownerOf: async () => undefined,
    gamesOf: async () => ({ games: [], next: undefined }),
    gameOf: async () => undefined,
    publishedVersionOf: async () => undefined,
    createGame: async () => ({ outcome: 'unattached' }),
    setVisibility: async () => ({ outcome: 'unattached' }),
    deleteGame: async () => ({ outcome: 'unattached' }),
    markPublished: async () => undefined,
};

export const unattachedWorkspaces: Workspaces = {
    workspaceOf: async () => undefined,
    fileOf: async () => undefined,
    saveWorkspace: async () => ({ outcome: 'missing' }),
};

export const unattachedTasks: Tasks = {
    queueBuild: async () => ({ outcome: 'unattached' }),
    taskOf: async () => undefined,
    claimTask: async () => ({ outcome: 'missing' }),
    uploadOf: async () => undefined,
    settleTask: async () => ({ outcome: 'missing' }),
    buildOf: async () => undefined,
    recordArtifact: async () => undefined,
    artifactsOf: async () => [],
    playableVersionOf: async () => undefined,
    dueForAnnouncement: async () => [],
    markAnnounced: async () => undefined,
    reapAbandoned: async () => [],
};

// The router keeps routing off its own registry; only the history it was handing over is dropped.
export const unattachedFleetHistory: FleetHistory = {
    recordFleet: async () => undefined,
};

export const unattachedStores: Stores = {
    accounts: unattachedAccounts,
    games: unattachedGames,
    workspaces: unattachedWorkspaces,
    tasks: unattachedTasks,
    fleetHistory: unattachedFleetHistory,
};
