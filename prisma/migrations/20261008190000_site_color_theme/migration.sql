-- Keep the existing green palette for current stores and new settings records.
-- The enum also prevents invalid values from bypassing application validation.
CREATE TYPE "SiteColorTheme" AS ENUM ('forest', 'honey');

ALTER TABLE "SiteSettings"
  ADD COLUMN "colorTheme" "SiteColorTheme" NOT NULL DEFAULT 'forest';
