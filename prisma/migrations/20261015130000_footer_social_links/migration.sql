ALTER TABLE "SiteSettings"
  ADD COLUMN "footerSocialLinks" JSONB NOT NULL DEFAULT '[]'::JSONB;

-- Migrate only the footer presentation. Preserve the original contact channels
-- for older clients and the contact page without rewriting unrelated settings.
UPDATE "SiteSettings" AS settings
SET "footerSocialLinks" = (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', social.icon,
    'label', social.label,
    'href', btrim(social.href),
    'icon', social.icon,
    'iconUrl', NULL,
    'enabled', TRUE
  ) ORDER BY social.position), '[]'::JSONB)
  FROM (VALUES
    (1, 'instagram', 'اینستاگرام', settings."instagramUrl"),
    (2, 'telegram', 'تلگرام', settings."telegramUrl"),
    (3, 'eitaa', 'ایتا', settings."eitaaUrl"),
    (4, 'whatsapp', 'واتساپ', settings."whatsappUrl")
  ) AS social(position, icon, label, href)
  WHERE social.href IS NOT NULL AND btrim(social.href) <> ''
);

ALTER TABLE "SiteSettings"
  ADD CONSTRAINT "SiteSettings_footerSocialLinks_array_check" CHECK (jsonb_typeof("footerSocialLinks") = 'array'),
  ADD CONSTRAINT "SiteSettings_footerSocialLinks_count_check" CHECK (jsonb_array_length("footerSocialLinks") <= 12);
