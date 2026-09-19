-- Queued work becomes one table for every kind, and a file names a bucket version rather than the
-- hash of its own bytes.

-- CreateEnum
CREATE TYPE "TaskKind" AS ENUM ('BUILD', 'ASSET_UPLOAD');
CREATE TYPE "TaskStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'SUCCESSFUL', 'FAILED', 'CANCELLED');
CREATE TYPE "FileKind" AS ENUM ('source', 'asset');

-- DropTable
-- DeploymentTask held a game, an account and a timestamp and no lifecycle at all; Task is the same
-- intent with the columns a worker needs, and it is dropped rather than left beside its successor.
DROP TABLE "DeploymentTask";

-- CreateTable
CREATE TABLE "Task" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "gameId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "kind" "TaskKind" NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "manifestRevision" INTEGER NOT NULL,
    "assetPath" VARCHAR(256),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "detail" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Task_gameId_createdAt_idx" ON "Task" ("gameId", "createdAt");
CREATE INDEX "Task_accountId_idx" ON "Task" ("accountId");
CREATE INDEX "Task_kind_status_createdAt_idx" ON "Task" ("kind", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
-- A publish no longer names a hash: what it pins to is the manifest revision, and the manifest
-- object at that revision is what names every file's version.
ALTER TABLE "Game" DROP CONSTRAINT "Game_published_together";
ALTER TABLE "Game" DROP COLUMN "publishedHash";

-- AlterTable
-- Content addressing is gone from the source path. A file is a key that is overwritten in place,
-- and the version the bucket minted for that write is what a manifest freezes.
--
-- The rows go with it rather than being backfilled: every one names a SHA-256 in a content-addressed
-- store, and no key in the games bucket corresponds to it. A row kept here would be a manifest entry
-- that resolves to nothing, which fails at build time instead of here. The revisions go back to zero
-- for the same reason -- a draft revision naming a set that no longer exists is worse than an editor
-- seeding its template again.
DELETE FROM "GameFile";
UPDATE "Game" SET "draftRevision" = 0, "publishedRevision" = NULL, "publishedAt" = NULL;

ALTER TABLE "GameFile" DROP CONSTRAINT "GameFile_hash_is_sha256";
ALTER TABLE "GameFile" DROP COLUMN "hash";
ALTER TABLE "GameFile"
    ADD COLUMN "kind" "FileKind" NOT NULL,
    ADD COLUMN "versionId" VARCHAR(1024) NOT NULL;


-- Everything below is hand-written, for the same reason the earlier migrations' tails are: Prisma's
-- schema language models no CHECK constraint and no partial index, and these are the invariants
-- that have to hold against a writer this service does not own.

-- Published is one fact in two columns now, and one without the other is a version nothing can be
-- fetched by or dated.
ALTER TABLE "Game"
    ADD CONSTRAINT "Game_published_together" CHECK (
        num_nonnulls("publishedRevision", "publishedAt") IN (0, 2));

-- An empty version id names no byte-set, and one with whitespace in it is not something a bucket
-- ever minted -- both would be a manifest that resolves to nothing at build time.
ALTER TABLE "GameFile"
    ADD CONSTRAINT "GameFile_version_is_opaque" CHECK ("versionId" ~ '^[!-~]+$');

-- A task is pinned to a manifest that exists, and a build of revision zero is a build of nothing.
-- An asset upload names the asset it is for, and nothing else may: a BUILD row carrying a path
-- would be settled against one file of a game it was queued to compile whole.
ALTER TABLE "Task"
    ADD CONSTRAINT "Task_revision_saved" CHECK ("manifestRevision" > 0),
    ADD CONSTRAINT "Task_attempts_nonneg" CHECK ("attempts" >= 0),
    ADD CONSTRAINT "Task_asset_path_matches_kind" CHECK (
        ("kind" = 'ASSET_UPLOAD') = ("assetPath" IS NOT NULL)),
    -- The same refusal the wire shape carries, restated where a backfill also meets it.
    ADD CONSTRAINT "Task_asset_path_is_relative" CHECK (
        "assetPath" IS NULL OR (
            "assetPath" ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'
            AND "assetPath" !~ '(^|/)[.][.]?(/|$)')),
    -- A task that finished before it started, or that is settled with no finish, is a lifecycle
    -- no worker produces and a sweeper cannot reason about.
    ADD CONSTRAINT "Task_finish_after_start" CHECK (
        "finishedAt" IS NULL OR ("startedAt" IS NOT NULL AND "finishedAt" >= "startedAt"));

-- One live task per game, kind, revision and asset, enforced here rather than by a read-then-write
-- in the service: two publishes of one manifest are one build, and the second gets the first's row
-- back. NULLS NOT DISTINCT is what makes that true of a build, whose asset path is null -- without
-- it two builds of one manifest would both be allowed, which is the rule this index exists for.
CREATE UNIQUE INDEX "Task_one_live_per_revision"
    ON "Task" ("gameId", "kind", "manifestRevision", "assetPath") NULLS NOT DISTINCT
    WHERE "status" IN ('NOT_STARTED', 'IN_PROGRESS');
