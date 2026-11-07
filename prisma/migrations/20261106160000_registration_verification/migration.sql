BEGIN;

ALTER TABLE "User"
  ALTER COLUMN "email" DROP NOT NULL,
  ADD COLUMN "loginPhone" TEXT,
  ADD COLUMN "emailVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "phoneVerifiedAt" TIMESTAMP(3),
  ADD CONSTRAINT "User_login_identity_check" CHECK ("email" IS NOT NULL OR "loginPhone" IS NOT NULL),
  ADD CONSTRAINT "User_verified_login_phone_check" CHECK (
    ("loginPhone" IS NULL AND "phoneVerifiedAt" IS NULL) OR
    ("loginPhone" IS NOT NULL AND "loginPhone" ~ '^09[0-9]{9}$' AND "phoneVerifiedAt" IS NOT NULL)
  );

CREATE UNIQUE INDEX "User_loginPhone_key" ON "User"("loginPhone");

CREATE TABLE "RegistrationSettings" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
  "smsEnabled" BOOLEAN NOT NULL DEFAULT false,
  "expiryMinutes" INTEGER NOT NULL DEFAULT 5,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "resendSeconds" INTEGER NOT NULL DEFAULT 60,
  "destinationHourlyLimit" INTEGER NOT NULL DEFAULT 5,
  "ipHourlyLimit" INTEGER NOT NULL DEFAULT 30,
  "emailSender" TEXT NOT NULL DEFAULT 'auth',
  "smsTemplate" TEXT NOT NULL DEFAULT '',
  "version" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RegistrationSettings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RegistrationSettings_singleton_check" CHECK ("id" = 1)
);

CREATE TABLE "RegistrationChallenge" (
  "id" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "destination" TEXT NOT NULL,
  "codeDigest" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "resendAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RegistrationChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RegistrationChallenge_channel_destination_key" ON "RegistrationChallenge"("channel", "destination");
CREATE INDEX "RegistrationChallenge_expiresAt_idx" ON "RegistrationChallenge"("expiresAt");

CREATE TABLE "RegistrationRateLimit" (
  "key" TEXT NOT NULL,
  "windowStartedAt" TIMESTAMP(3) NOT NULL,
  "count" INTEGER NOT NULL,
  CONSTRAINT "RegistrationRateLimit_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "RegistrationRateLimit_windowStartedAt_idx" ON "RegistrationRateLimit"("windowStartedAt");

COMMIT;
