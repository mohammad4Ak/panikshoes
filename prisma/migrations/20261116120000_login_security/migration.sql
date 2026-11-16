CREATE TABLE "LoginSecuritySettings" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "version" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "windowMinutes" INTEGER NOT NULL DEFAULT 15,
  "lockMinutes" INTEGER NOT NULL DEFAULT 15,
  "ipMaxAttempts" INTEGER NOT NULL DEFAULT 30,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LoginSecuritySettings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LoginSecuritySettings_bounds" CHECK (
    "id" = 1 AND "version" >= 0 AND "maxAttempts" BETWEEN 3 AND 20
    AND "windowMinutes" BETWEEN 1 AND 60 AND "lockMinutes" BETWEEN 1 AND 60
    AND "ipMaxAttempts" BETWEEN 10 AND 200 AND "ipMaxAttempts" >= "maxAttempts"
  )
);

CREATE TABLE "LoginAttemptWindow" (
  "key" TEXT NOT NULL,
  "windowStartedAt" TIMESTAMP(3) NOT NULL,
  "failures" INTEGER NOT NULL,
  "blockedUntil" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LoginAttemptWindow_pkey" PRIMARY KEY ("key"),
  CONSTRAINT "LoginAttemptWindow_failures_check" CHECK ("failures" >= 0)
);
CREATE INDEX "LoginAttemptWindow_updatedAt_idx" ON "LoginAttemptWindow"("updatedAt");
