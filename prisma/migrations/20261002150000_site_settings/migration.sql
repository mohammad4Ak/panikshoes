CREATE TABLE "SiteSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "storeName" TEXT NOT NULL,
    "tagline" TEXT NOT NULL,
    "logoUrl" TEXT,
    "logoLightUrl" TEXT,
    "announcementEnabled" BOOLEAN NOT NULL DEFAULT false,
    "announcementText" TEXT NOT NULL DEFAULT '',
    "announcementLink" TEXT,
    "announcementLinkLabel" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "supportHours" TEXT NOT NULL DEFAULT '',
    "instagramUrl" TEXT,
    "telegramUrl" TEXT,
    "seoTitle" TEXT NOT NULL,
    "seoDescription" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SiteSettings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SiteSettings_singleton" CHECK ("id" = 1),
    CONSTRAINT "SiteSettings_version_positive" CHECK ("version" > 0)
);

INSERT INTO "SiteSettings" (
    "id", "storeName", "tagline", "phone", "email", "address", "supportHours",
    "seoTitle", "seoDescription", "updatedAt"
) VALUES (
    1, 'کفش لند', 'برای روزهایی که یک‌جا بند نمی‌شی.', '02112345678', 'info@shoeland.ir',
    'تهران، خیابان ولیعصر، پلاک ۱۲۳۴',
    E'شنبه تا چهارشنبه: ۹ صبح تا ۹ شب\nپنجشنبه: ۹ صبح تا ۵ عصر\nجمعه: تعطیل',
    'کفش لند - فروشگاه آنلاین کفش', 'فروشگاه تخصصی کفش کتانی و رسمی', CURRENT_TIMESTAMP
);
