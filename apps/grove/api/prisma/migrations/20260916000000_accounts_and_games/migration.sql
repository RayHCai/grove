-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Account" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(254) NOT NULL,
    "displayName" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordCredential" (
    "accountId" UUID NOT NULL,
    "hash" VARCHAR(255) NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastFailedAt" TIMESTAMPTZ(3),
    "lockedUntil" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PasswordCredential_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "PasswordReset" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "accountId" UUID NOT NULL,
    "tokenHash" BYTEA NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Game" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ownerId" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Game_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentTask" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "gameId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameAsset" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "gameId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_email_key" ON "Account"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordReset_tokenHash_key" ON "PasswordReset"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordReset_accountId_idx" ON "PasswordReset"("accountId");

-- CreateIndex
CREATE INDEX "PasswordReset_expiresAt_idx" ON "PasswordReset"("expiresAt");

-- CreateIndex
CREATE INDEX "Game_ownerId_createdAt_idx" ON "Game"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "DeploymentTask_gameId_createdAt_idx" ON "DeploymentTask"("gameId", "createdAt");

-- CreateIndex
CREATE INDEX "DeploymentTask_accountId_idx" ON "DeploymentTask"("accountId");

-- CreateIndex
CREATE INDEX "GameAsset_gameId_createdAt_idx" ON "GameAsset"("gameId", "createdAt");

-- AddForeignKey
ALTER TABLE "PasswordCredential" ADD CONSTRAINT "PasswordCredential_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordReset" ADD CONSTRAINT "PasswordReset_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Game" ADD CONSTRAINT "Game_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentTask" ADD CONSTRAINT "DeploymentTask_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentTask" ADD CONSTRAINT "DeploymentTask_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameAsset" ADD CONSTRAINT "GameAsset_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Everything below is hand-written: Prisma's schema language models no CHECK constraint and no
-- partial index, and these are the invariants that must hold against writers this service does not
-- own -- a psql session, a backfill, a future service.

-- A row that skipped folding is a second account for one mailbox, and a sign-in looks an address up
-- by exact match. The C collation folds only ASCII, which is all a JavaScript toLowerCase() can
-- leave behind here, so this never rejects a row the service itself wrote.
ALTER TABLE "Account"
    ADD CONSTRAINT "Account_email_folded" CHECK ("email" = lower("email" COLLATE "C")),
    ADD CONSTRAINT "Account_email_present" CHECK (length("email") >= 3);

-- Anything that is not an argon2id PHC string here is a bcrypt hash, a plaintext password, or a
-- sentinel standing in for "no password" -- and all three are the same bug.
ALTER TABLE "PasswordCredential"
    ADD CONSTRAINT "PasswordCredential_hash_is_argon2id" CHECK ("hash" LIKE '$argon2id$v=19$%'),
    ADD CONSTRAINT "PasswordCredential_attempts_nonneg" CHECK ("failedAttempts" >= 0);

-- A digest of the wrong width is a truncated one, and a key that was born expired is a bug in
-- whatever issued it rather than a key.
ALTER TABLE "PasswordReset"
    ADD CONSTRAINT "PasswordReset_hash_is_sha256" CHECK (octet_length("tokenHash") = 32),
    ADD CONSTRAINT "PasswordReset_expires_after_issue" CHECK ("expiresAt" > "createdAt");

-- At most one live key per account, so asking for a reset a thousand times leaves one door open
-- rather than a thousand. Issuing sweeps the account's earlier rows inside the same transaction.
CREATE UNIQUE INDEX "PasswordReset_one_live_per_account"
    ON "PasswordReset" ("accountId") WHERE "consumedAt" IS NULL;
