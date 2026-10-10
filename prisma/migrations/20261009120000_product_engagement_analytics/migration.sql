CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
ALTER TABLE "Product" ADD COLUMN "specifications" JSONB NOT NULL DEFAULT '[]', ADD COLUMN "viewCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Product" ADD CONSTRAINT "Product_specifications_array" CHECK (jsonb_typeof("specifications") = 'array'), ADD CONSTRAINT "Product_viewCount_nonnegative" CHECK ("viewCount" >= 0);
CREATE TABLE "ProductReview" (
 "id" TEXT NOT NULL, "productId" TEXT NOT NULL, "userId" TEXT NOT NULL, "rating" INTEGER NOT NULL,
 "comment" TEXT NOT NULL DEFAULT '', "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
 "revision" INTEGER NOT NULL DEFAULT 1, "moderationNote" TEXT, "reviewerId" TEXT, "reviewedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "ProductReview_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "ProductReview_rating_range" CHECK ("rating" BETWEEN 1 AND 5),
 CONSTRAINT "ProductReview_comment_length" CHECK (char_length("comment") <= 2000)
);
CREATE UNIQUE INDEX "ProductReview_productId_userId_key" ON "ProductReview"("productId", "userId");
CREATE INDEX "ProductReview_productId_status_createdAt_idx" ON "ProductReview"("productId", "status", "createdAt");
CREATE INDEX "ProductReview_status_updatedAt_idx" ON "ProductReview"("status", "updatedAt");
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "PageView" (
 "id" TEXT NOT NULL, "visitorId" TEXT NOT NULL, "pathname" TEXT NOT NULL,
 "ipAddress" TEXT, "userAgent" TEXT, "referrer" TEXT, "productId" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "PageView_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PageView_createdAt_idx" ON "PageView"("createdAt");
CREATE INDEX "PageView_visitorId_createdAt_idx" ON "PageView"("visitorId", "createdAt");
CREATE INDEX "PageView_visitorId_pathname_createdAt_idx" ON "PageView"("visitorId", "pathname", "createdAt");
CREATE INDEX "PageView_productId_createdAt_idx" ON "PageView"("productId", "createdAt");
ALTER TABLE "PageView" ADD CONSTRAINT "PageView_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
