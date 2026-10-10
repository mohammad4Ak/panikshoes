BEGIN;

CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'AWAITING_RECEIPT', 'AWAITING_REVIEW', 'REJECTED', 'PAID', 'EXPIRED');
CREATE TYPE "ReceiptStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "Order"
  ADD COLUMN "paymentMethod" TEXT,
  ADD COLUMN "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
  ADD COLUMN "paymentExpiresAt" TIMESTAMP(3),
  ADD COLUMN "paymentCardNumber" TEXT,
  ADD COLUMN "paymentCardholderName" TEXT,
  ADD COLUMN "paymentBankName" TEXT;

-- Historical verified payments retain their financial status.
UPDATE "Order" SET "paymentStatus" = 'PAID' WHERE "verified" = true;

CREATE TABLE "PaymentMethod" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  "cardNumber" TEXT,
  "cardholderName" TEXT,
  "bankName" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentReceipt" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "data" BYTEA NOT NULL,
  "mimeType" TEXT NOT NULL,
  "payerCardLast4" TEXT,
  "transferReference" TEXT,
  "submissionKey" TEXT NOT NULL,
  "isLate" BOOLEAN NOT NULL DEFAULT false,
  "status" "ReceiptStatus" NOT NULL DEFAULT 'PENDING',
  "reviewNote" TEXT,
  "reviewerId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentReceipt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "Order_paymentMethod_paymentStatus_paymentExpiresAt_idx" ON "Order"("paymentMethod", "paymentStatus", "paymentExpiresAt");
CREATE UNIQUE INDEX "PaymentReceipt_orderId_submissionKey_key" ON "PaymentReceipt"("orderId", "submissionKey");
CREATE INDEX "PaymentReceipt_orderId_createdAt_idx" ON "PaymentReceipt"("orderId", "createdAt");
CREATE INDEX "PaymentReceipt_status_createdAt_idx" ON "PaymentReceipt"("status", "createdAt");

INSERT INTO "PaymentMethod" ("id", "name", "description", "sortOrder", "updatedAt") VALUES
('bank_transfer', 'کارت به کارت', 'واریز به کارت فروشگاه و ارسال رسید برای بررسی ادمین', 0, CURRENT_TIMESTAMP),
('zarinpal', 'زرین‌پال', 'پرداخت اینترنتی؛ اتصال درگاه هنوز تکمیل نشده است', 1, CURRENT_TIMESTAMP);

COMMIT;
