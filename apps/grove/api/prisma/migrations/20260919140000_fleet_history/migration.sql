-- Where the fleet's history is kept, because @grove/server-manager's own registry cannot keep it:
-- one interval of heartbeats rebuilds what the fleet *is*, and no later beat carries what it did.

-- CreateEnum
CREATE TYPE "FleetLiveness" AS ENUM ('healthy', 'suspected', 'left', 'failed');
CREATE TYPE "FleetEventKind" AS ENUM ('registered', 'restarted', 'suspected', 'left', 'failed', 'returned');

-- CreateTable
-- The id is the router's host id and carries no default: a box is named by the fleet it beat into,
-- never minted here, so a report that arrives twice updates one row.
CREATE TABLE "FleetHost" (
    "id" UUID NOT NULL,
    "region" VARCHAR(64) NOT NULL,
    "liveness" "FleetLiveness" NOT NULL,
    "incarnation" UUID NOT NULL,
    "runningInstances" INTEGER NOT NULL,
    "maxInstances" INTEGER NOT NULL,
    "cpuLoad" DOUBLE PRECISION NOT NULL,
    -- Bytes, so 64-bit: a box with more than 2 GiB free overflows an INTEGER, which is every box.
    "memoryFreeBytes" BIGINT NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "FleetHost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- No foreign key to FleetHost, deliberately: the row an operator goes looking for is the box that
-- failed and never came back, and a cascade from a reaped host would take exactly that one.
CREATE TABLE "FleetHostEvent" (
    "id" UUID NOT NULL,
    "hostId" UUID NOT NULL,
    "region" VARCHAR(64) NOT NULL,
    "kind" "FleetEventKind" NOT NULL,
    "incarnation" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "detail" VARCHAR(512),

    CONSTRAINT "FleetHostEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The operator's read: one box's history, newest first.
CREATE INDEX "FleetHostEvent_hostId_at_idx" ON "FleetHostEvent" ("hostId", "at" DESC);
-- The reaper's read: everything past the retention window, whichever box it belongs to.
CREATE INDEX "FleetHostEvent_at_idx" ON "FleetHostEvent" ("at");
CREATE INDEX "FleetHost_region_liveness_idx" ON "FleetHost" ("region", "liveness");
