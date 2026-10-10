'use client'

import Link from 'next/link'
import { ArrowUpLeft, Megaphone } from 'lucide-react'
import { useSiteSettings } from './SiteSettingsProvider'
import styles from './announcement.module.css'

export default function AnnouncementBar() {
  const settings = useSiteSettings()
  if (!settings.announcementEnabled || !settings.announcementText.trim()) return null

  return (
    <aside className={styles.bar} aria-label="اطلاعیهٔ فروشگاه">
      <div className={styles.inner}>
        <span className={styles.icon} aria-hidden="true"><Megaphone size={17} /></span>
        <p>{settings.announcementText}</p>
        {settings.announcementLink && settings.announcementLinkLabel && <Link href={settings.announcementLink} className={styles.link}>
          <span>{settings.announcementLinkLabel}</span><ArrowUpLeft size={15} aria-hidden="true" />
        </Link>}
      </div>
    </aside>
  )
}
