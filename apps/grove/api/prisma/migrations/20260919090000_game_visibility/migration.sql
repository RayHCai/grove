-- Who may reach a game, and the index the allocator finds its newest finished build through.

-- CreateEnum
CREATE TYPE "GameVisibility" AS ENUM ('private', 'unlisted', 'public');

-- AlterTable
-- Private for every row that already exists as well as every row to come: a game that was created
-- before anybody could say who may play it has not been shared with anybody, and defaulting the
-- backfill the other way would publish every draft in the table at once.
ALTER TABLE "Game" ADD COLUMN "visibility" "GameVisibility" NOT NULL DEFAULT 'private';

-- CreateIndex
-- The allocator reads this on the path of every join: the newest BUILD of one game that succeeded.
CREATE INDEX "Task_gameId_kind_status_manifestRevision_idx" ON "Task" ("gameId", "kind", "status", "manifestRevision");
