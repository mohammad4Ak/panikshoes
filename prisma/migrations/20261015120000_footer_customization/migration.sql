-- Additive presentation settings: existing branding and store data stay intact.
ALTER TABLE "SiteSettings"
  ADD COLUMN "footerDescription" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "footerCopyright" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "footerLinks" JSONB NOT NULL DEFAULT '[{"id":"products","label":"همهٔ محصولات","href":"/products"},{"id":"about","label":"دربارهٔ ما","href":"/about"},{"id":"contact","label":"تماس با ما","href":"/contact"},{"id":"tracking","label":"پیگیری سفارش","href":"/profile"},{"id":"account","label":"حساب کاربری","href":"/profile"},{"id":"cart","label":"سبد خرید","href":"/cart"}]'::JSONB,
  ADD COLUMN "footerBadges" JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN "eitaaUrl" TEXT,
  ADD COLUMN "whatsappUrl" TEXT;

ALTER TABLE "SiteSettings"
  ADD CONSTRAINT "SiteSettings_footerLinks_array_check" CHECK (jsonb_typeof("footerLinks") = 'array'),
  ADD CONSTRAINT "SiteSettings_footerBadges_array_check" CHECK (jsonb_typeof("footerBadges") = 'array'),
  ADD CONSTRAINT "SiteSettings_footerLinks_count_check" CHECK (jsonb_array_length("footerLinks") <= 10),
  ADD CONSTRAINT "SiteSettings_footerBadges_count_check" CHECK (jsonb_array_length("footerBadges") <= 8);
