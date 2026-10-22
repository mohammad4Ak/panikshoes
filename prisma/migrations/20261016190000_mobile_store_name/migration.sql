-- Existing stores keep their current mobile branding until an administrator changes it.
ALTER TABLE "SiteSettings"
ADD COLUMN "showMobileStoreName" BOOLEAN NOT NULL DEFAULT true;
