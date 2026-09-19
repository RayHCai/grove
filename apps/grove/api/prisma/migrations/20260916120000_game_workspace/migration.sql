-- The workspace a game is authored in: one row per path, and the revision that names the set.

-- DropTable
-- GameAsset held an id, a game and a timestamp and named no object; GameFile is the same intent
-- with the columns it was missing, keyed by the path rather than by a surrogate.
DROP TABLE "GameAsset";

-- AlterTable
ALTER TABLE "Game"
    ADD COLUMN "draftRevision" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "publishedHash" CHAR(64),
    ADD COLUMN "publishedRevision" INTEGER,
    ADD COLUMN "publishedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "GameFile" (
    "gameId" UUID NOT NULL,
    "path" VARCHAR(256) NOT NULL,
    "hash" CHAR(64) NOT NULL,
    "byteLength" INTEGER NOT NULL,
    "contentType" VARCHAR(128) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GameFile_pkey" PRIMARY KEY ("gameId", "path")
);

-- AddForeignKey
ALTER TABLE "GameFile" ADD CONSTRAINT "GameFile_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Everything below is hand-written, for the same reason the first migration's tail is: these are
-- the invariants that have to hold against a writer this service does not own.

-- A revision only ever moves forward, and a publish names a revision that was saved. Nothing here
-- can check WHICH revision was published, but a publish of revision zero is a publish of nothing.
ALTER TABLE "Game"
    ADD CONSTRAINT "Game_draft_revision_nonneg" CHECK ("draftRevision" >= 0),
    ADD CONSTRAINT "Game_published_revision_saved" CHECK (
        "publishedRevision" IS NULL OR "publishedRevision" > 0),
    -- Published is one fact in three columns, and two of them without the third is a version
    -- nothing can be fetched by or dated.
    ADD CONSTRAINT "Game_published_together" CHECK (
        num_nonnulls("publishedHash", "publishedRevision", "publishedAt") IN (0, 3));

-- A name that is not a full lowercase SHA-256 names no object the store will ever answer for, and a
-- negative length is not a file. Zero is: a creator made a file and has not written to it.
ALTER TABLE "GameFile"
    ADD CONSTRAINT "GameFile_hash_is_sha256" CHECK ("hash" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "GameFile_length_nonneg" CHECK ("byteLength" >= 0),
    -- The same refusal the wire shape carries, restated where a backfill also meets it: a path that
    -- escapes its game, or is spelled with a separator no archive agrees on, names another game's file.
    ADD CONSTRAINT "GameFile_path_is_relative" CHECK (
        "path" ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$'
        AND "path" !~ '(^|/)[.][.]?(/|$)');
