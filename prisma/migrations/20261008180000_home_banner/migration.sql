-- The homepage banner uses the existing singleton settings record.
-- Existing branding, contacts and announcements retain their stored values.
ALTER TABLE "SiteSettings"
  ADD COLUMN "homeBannerEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "homeBannerImageUrl" TEXT,
  ADD COLUMN "homeBannerEyebrow" TEXT NOT NULL DEFAULT 'از شهر تا مسیرهای تازه',
  ADD COLUMN "homeBannerTitle" TEXT NOT NULL DEFAULT 'مسیر بعدی‌ات از اینجا شروع می‌شه.',
  ADD COLUMN "homeBannerDescription" TEXT NOT NULL DEFAULT 'برای قدم‌های هر روز و ماجراجویی‌های آخر هفته، همراهت رو پیدا کن.',
  ADD COLUMN "homeBannerLink" TEXT DEFAULT '/products?stock=1',
  ADD COLUMN "homeBannerLinkLabel" TEXT NOT NULL DEFAULT 'کشف مدل‌های موجود',
  ADD COLUMN "homeBannerImageAlt" TEXT NOT NULL DEFAULT 'کفش طبیعت‌گردی در یک مسیر کوهستانی';
