-- Independent recovery settings; no existing identity or credential is changed.
CREATE TABLE "PasswordResetSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "smsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "expiryMinutes" INTEGER NOT NULL DEFAULT 5,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "resendSeconds" INTEGER NOT NULL DEFAULT 60,
    "destinationHourlyLimit" INTEGER NOT NULL DEFAULT 5,
    "ipHourlyLimit" INTEGER NOT NULL DEFAULT 30,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PasswordResetSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PasswordResetChallenge" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "userId" TEXT,
    "authVersion" INTEGER,
    "settingsVersion" INTEGER NOT NULL,
    "deliveryVersion" INTEGER NOT NULL,
    "codeDigest" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resendAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PasswordResetChallenge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PasswordResetRateLimit" (
    "key" TEXT NOT NULL,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL,
    CONSTRAINT "PasswordResetRateLimit_pkey" PRIMARY KEY ("key")
);

CREATE UNIQUE INDEX "PasswordResetChallenge_channel_destination_key" ON "PasswordResetChallenge"("channel", "destination");
CREATE INDEX "PasswordResetChallenge_expiresAt_idx" ON "PasswordResetChallenge"("expiresAt");
CREATE INDEX "PasswordResetRateLimit_windowStartedAt_idx" ON "PasswordResetRateLimit"("windowStartedAt");

-- Ensure the singleton is available for the recovery configuration lock.
INSERT INTO "PasswordResetSettings" ("id", "updatedAt") VALUES (1, CURRENT_TIMESTAMP);
