'use client'

import Image from 'next/image'
import { useState } from 'react'
import PanikMark from './PanikMark'
import { useSiteSettings } from '@/components/layout/SiteSettingsProvider'

export default function BrandLogo({ variant = 'dark' }: { variant?: 'dark' | 'light' }) {
  const settings = useSiteSettings()
  const url = variant === 'light' ? settings.logoLightUrl || settings.logoUrl : settings.logoUrl
  const [failedUrl, setFailedUrl] = useState('')
  return url && failedUrl !== url
    ? <Image src={url} alt="" width={120} height={120} unoptimized className="h-full w-full min-h-0 min-w-0 object-contain" onError={() => setFailedUrl(url)} />
    : <PanikMark size="100%" variant={variant} />
}
