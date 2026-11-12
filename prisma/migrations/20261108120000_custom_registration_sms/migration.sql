ALTER TABLE "RegistrationSettings"
  ADD COLUMN "smsProvider" TEXT NOT NULL DEFAULT 'kavenegar',
  ADD COLUMN "smsApiUrl" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "smsMethod" TEXT NOT NULL DEFAULT 'POST',
  ADD COLUMN "smsBodyFormat" TEXT NOT NULL DEFAULT 'json',
  ADD COLUMN "smsBodyTemplate" TEXT NOT NULL DEFAULT '{"mobile":"{{phone}}","code":"{{code}}"}',
  ADD COLUMN "smsHeadersEncrypted" TEXT,
  ADD COLUMN "smsApiKeyEncrypted" TEXT,
  ADD COLUMN "smsSuccessPath" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "smsSuccessValue" TEXT NOT NULL DEFAULT '200';
