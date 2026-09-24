-- An asset carries a verdict about its own bytes, and the task that reached it names which bytes.

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "assetVersionId" VARCHAR(1024);
ALTER TABLE "GameFile" ADD COLUMN "validatedVersionId" VARCHAR(1024);

-- Existing asset tasks predate the column, so each takes the version its file holds now. One that
-- names a path the game no longer has is work nothing can be a verdict about, and it goes: leaving
-- it would be a row the CHECK below refuses.
UPDATE "Task" t
   SET "assetVersionId" = f."versionId"
  FROM "GameFile" f
 WHERE t."kind" = 'ASSET_UPLOAD'
   AND f."gameId" = t."gameId"
   AND f."path" = t."assetPath";

DELETE FROM "Task" WHERE "kind" = 'ASSET_UPLOAD' AND "assetVersionId" IS NULL;

-- The verdicts those tasks already carried, written where the new code would have written them.
-- Without this every game saved before today would be unpublishable until each asset was saved
-- again, which is a migration taking a creator's work away rather than moving it forward.
UPDATE "GameFile" f
   SET "validatedVersionId" = f."versionId"
  FROM "Task" t
 WHERE t."kind" = 'ASSET_UPLOAD'
   AND t."status" = 'SUCCESSFUL'
   AND t."gameId" = f."gameId"
   AND t."assetPath" = f."path"
   AND t."assetVersionId" = f."versionId";

-- Hand-written, as the earlier migrations' tails are: Prisma's schema language models no CHECK.

-- An asset upload is a verdict about one byte-set and says which; nothing else may carry one,
-- because a BUILD row naming a version would be a build vouching for a single file.
ALTER TABLE "Task"
    ADD CONSTRAINT "Task_asset_version_matches_kind" CHECK (
        ("kind" = 'ASSET_UPLOAD') = ("assetVersionId" IS NOT NULL)),
    ADD CONSTRAINT "Task_asset_version_is_opaque" CHECK (
        "assetVersionId" IS NULL OR "assetVersionId" ~ '^[!-~]+$');

-- The same shape `versionId` already holds, for the same reason: a verdict naming something no
-- bucket ever minted could never equal the version it is compared against.
ALTER TABLE "GameFile"
    ADD CONSTRAINT "GameFile_validated_version_is_opaque" CHECK (
        "validatedVersionId" IS NULL OR "validatedVersionId" ~ '^[!-~]+$'),
    -- Only an asset is verified. A source file carrying a verdict would read as one that had been,
    -- and the publish gate counts assets by asking exactly this question of every row.
    ADD CONSTRAINT "GameFile_only_assets_are_validated" CHECK (
        "validatedVersionId" IS NULL OR "kind" = 'asset');

-- The publish gate's read: every asset of one game whose verdict does not name the bytes it holds.
CREATE INDEX "GameFile_gameId_kind_idx" ON "GameFile" ("gameId", "kind");
