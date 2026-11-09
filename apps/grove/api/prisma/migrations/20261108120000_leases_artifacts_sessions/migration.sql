-- A claim becomes a lease, a build's outputs are recorded, a save's manifest is named by the save,
-- an asset's inspected copy is named apart from its upload, and sessions leave the process.

-- AlterTable
ALTER TABLE "Game" ADD COLUMN "draftSaveId" UUID;

-- AlterTable
ALTER TABLE "Task"
    ADD COLUMN "manifestSaveId" UUID,
    ADD COLUMN "claimedBy" VARCHAR(128),
    ADD COLUMN "leaseUntil" TIMESTAMPTZ(3),
    ADD COLUMN "announcedAt" TIMESTAMPTZ(3);

-- A task was announced when it was queued, and a claim already in flight holds a lease that has run
-- out: the sweeper takes it back rather than leaving it stranded with no deadline at all.
UPDATE "Task" SET "announcedAt" = "createdAt";
UPDATE "Task" SET "leaseUntil" = "updatedAt" WHERE "status" = 'IN_PROGRESS';

ALTER TABLE "Task"
    ALTER COLUMN "announcedAt" SET NOT NULL,
    ALTER COLUMN "announcedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- DropIndex
-- The sweeper no longer reads by creation; it reads by announcement and by lease.
DROP INDEX "Task_kind_status_createdAt_idx";

-- CreateIndex
CREATE INDEX "Task_kind_status_announcedAt_idx" ON "Task" ("kind", "status", "announcedAt");
CREATE INDEX "Task_status_leaseUntil_idx" ON "Task" ("status", "leaseUntil");

-- AlterTable
ALTER TABLE "GameFile" ADD COLUMN "edgeVersionId" VARCHAR(1024);

-- An asset verified while its bytes were written straight to `assets/` was verified where it sat, so
-- the copy the edge serves is the version the row already names.
UPDATE "GameFile"
   SET "edgeVersionId" = "versionId"
 WHERE "kind" = 'asset'
   AND "validatedVersionId" = "versionId";

-- CreateTable
CREATE TABLE "BuildArtifact" (
    "taskId" UUID NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "hash" CHAR(64) NOT NULL,
    "byteLength" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuildArtifact_pkey" PRIMARY KEY ("taskId", "url")
);

-- CreateTable
CREATE TABLE "Session" (
    "idHash" BYTEA NOT NULL,
    "playerId" UUID NOT NULL,
    "data" JSONB NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("idHash")
);

-- CreateIndex
CREATE INDEX "Session_playerId_idx" ON "Session" ("playerId");
CREATE INDEX "Session_expiresAt_idx" ON "Session" ("expiresAt");

-- AddForeignKey
ALTER TABLE "BuildArtifact" ADD CONSTRAINT "BuildArtifact_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written, as the earlier migrations' tails are: Prisma's schema language models no CHECK.

ALTER TABLE "Task"
    -- A claim in flight always says until when; one with no end is a task nobody may take back.
    ADD CONSTRAINT "Task_claim_has_lease" CHECK (
        "status" <> 'IN_PROGRESS' OR "leaseUntil" IS NOT NULL),
    -- Only a build compiles a manifest, so only a build names the save that froze one.
    ADD CONSTRAINT "Task_manifest_save_matches_kind" CHECK (
        "manifestSaveId" IS NULL OR "kind" = 'BUILD');

ALTER TABLE "GameFile"
    ADD CONSTRAINT "GameFile_edge_version_is_opaque" CHECK (
        "edgeVersionId" IS NULL OR "edgeVersionId" ~ '^[!-~]+$'),
    -- A copy reaches the edge only once an inspection passed, so there is no copy without a verdict.
    ADD CONSTRAINT "GameFile_edge_copy_is_inspected" CHECK (
        "edgeVersionId" IS NULL OR "validatedVersionId" IS NOT NULL);

-- Content-addressed: a digest of the wrong shape is a key no success can name.
ALTER TABLE "BuildArtifact"
    ADD CONSTRAINT "BuildArtifact_hash_is_sha256" CHECK ("hash" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "BuildArtifact_length_nonneg" CHECK ("byteLength" >= 0);

-- The digest of the id and never the id: a read of this table must not be a way into a session.
ALTER TABLE "Session"
    ADD CONSTRAINT "Session_id_is_sha256" CHECK (octet_length("idHash") = 32);
