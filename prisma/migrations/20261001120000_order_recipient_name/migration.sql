-- Nullable for existing orders; new orders keep the recipient entered at checkout.
ALTER TABLE "Order" ADD COLUMN "recipientName" TEXT;
