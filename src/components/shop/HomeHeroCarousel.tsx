'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { ArrowLeft, ArrowRight, ArrowUpLeft, MoveUpRight } from 'lucide-react'
import type { HomeHeroSlide } from '@/lib/home-hero'
import home from '@/app/(shop)/home.module.css'
import styles from './home-hero-carousel.module.css'

export type { HomeHeroSlide } from '@/lib/home-hero'

const motionQuery = '(prefers-reduced-motion: reduce)'
const serverReducedMotion = () => true
const serverVisible = () => false
const serverInteracting = () => false
const readReducedMotion = () => window.matchMedia(motionQuery).matches
const readVisible = () => document.visibilityState === 'visible'
function subscribeReducedMotion(change: () => void) {
  const preference = window.matchMedia(motionQuery)
  preference.addEventListener('change', change)
  return () => preference.removeEventListener('change', change)
}
function subscribeVisibility(change: () => void) {
  document.addEventListener('visibilitychange', change)
  return () => document.removeEventListener('visibilitychange', change)
}

export default function HomeHeroCarousel({ products, intervalSeconds = 10 }: { products: HomeHeroSlide[]; intervalSeconds: number }) {
  const root = useRef<HTMLDivElement>(null)
  const carouselId = useId()
  const slides = useMemo(() => {
    const seen = new Set<string>()
    return products.filter((product) => {
      if (!product.id || !product.slug || !product.image?.trim() || seen.has(product.id)) return false
      seen.add(product.id)
      return true
    }).slice(0, 10)
  }, [products])
  const [activeId, setActiveId] = useState(() => products[0]?.id ?? '')
  const [navigation, setNavigation] = useState(0)
  const activeIndex = Math.max(0, slides.findIndex((product) => product.id === activeId))
  const multiple = slides.length > 1
  const interval = Math.min(120, Math.max(5, Number.isFinite(intervalSeconds) ? intervalSeconds : 10)) * 1000
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, readReducedMotion, serverReducedMotion)
  const visible = useSyncExternalStore(subscribeVisibility, readVisible, serverVisible)

  // Include the actual header and optional announcement in the first-screen budget.
  useEffect(() => {
    const hero = root.current?.parentElement?.parentElement
    if (!hero) return
    let frame = 0
    const measure = () => {
      const top = Math.ceil(hero.getBoundingClientRect().top + window.scrollY)
      hero.style.setProperty('--hero-top', `${Math.max(0, top)}px`)
    }
    const schedule = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(measure)
    }
    measure()
    const observer = new ResizeObserver(schedule)
    const shell = hero.closest('.shop-shell')
    if (shell) observer.observe(shell)
    const header = shell?.querySelector('header')
    if (header) observer.observe(header)
    window.addEventListener('resize', schedule)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.cancelAnimationFrame(frame)
      hero.style.removeProperty('--hero-top')
    }
  }, [])

  // Listen on the visual panel so its backdrop, image, caption and controls
  // all pause rotation, including the gap between the image and caption.
  const subscribeInteraction = useCallback((change: () => void) => {
    const panel = root.current?.parentElement
    if (!panel) return () => {}
    const events = ['mouseenter', 'mouseleave', 'focusin', 'focusout']
    events.forEach((event) => panel.addEventListener(event, change))
    return () => events.forEach((event) => panel.removeEventListener(event, change))
  }, [])
  const readInteraction = useCallback(() => {
    const panel = root.current?.parentElement
    return !!panel && (panel.matches(':hover') || panel.contains(document.activeElement))
  }, [])
  const interacting = useSyncExternalStore(subscribeInteraction, readInteraction, serverInteracting)
  const rotationEnabled = !reducedMotion

  useEffect(() => {
    if (!multiple || !rotationEnabled || !visible || interacting) return
    const timer = window.setTimeout(() => {
      setActiveId(slides[(activeIndex + 1) % slides.length].id)
    }, interval)
    return () => window.clearTimeout(timer)
  }, [slides, activeIndex, interval, multiple, rotationEnabled, visible, interacting, navigation])

  function goTo(index: number) {
    if (!slides.length) return
    const target = (index + slides.length) % slides.length
    setActiveId(slides[target].id)
    setNavigation((current) => current + 1)
  }
  function handleControlKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'ArrowLeft') { event.preventDefault(); goTo(activeIndex + 1) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); goTo(activeIndex - 1) }
    else if (event.key === 'Home') { event.preventDefault(); goTo(0) }
    else if (event.key === 'End') { event.preventDefault(); goTo(slides.length - 1) }
  }

  if (!slides.length) return null

  return <div ref={root} className={styles.root} role="group" aria-roledescription={multiple ? 'carousel' : undefined} aria-label="مدل‌های پیشنهادی فروشگاه" aria-live="off">
    <div className={styles.imageSlot}>
      <div className={styles.imageFrame}>
        <div className={styles.backdrop} aria-hidden="true" />
        <span className={styles.word} dir="ltr" aria-hidden="true">MOVE.</span>
        <div id={carouselId} className={`${home.heroShoe} ${styles.imageStage}`}>
          {slides.map((product, index) => {
            const active = index === activeIndex
            return <Link key={product.id} href={`/products/${encodeURIComponent(product.slug)}`} className={`${styles.imageSlide} ${active ? styles.active : ''}`} tabIndex={active ? 0 : -1} aria-hidden={!active} aria-label={`مشاهدهٔ ${product.name}`}>
              <Image src={product.image} alt={active ? product.name : ''} fill preload={index === 0} loading={index === 0 ? undefined : index === (activeIndex + 1) % slides.length ? 'eager' : 'lazy'} sizes="(max-width: 700px) 90vw, 48vw" unoptimized={product.image.startsWith('http')} />
            </Link>
          })}
        </div>
        <span className={styles.sticker} dir="ltr" aria-hidden="true">KEEP<br />MOVING <MoveUpRight aria-hidden="true" /></span>
        {multiple && <div className={styles.controls} role="group" aria-label="کنترل نمایش محصولات" onKeyDown={handleControlKey}>
          <button type="button" onClick={() => goTo(activeIndex - 1)} className={`${styles.controlButton} ${styles.previous}`} aria-label="نمایش محصول قبلی" aria-controls={carouselId} title="محصول قبلی"><ArrowRight size={20} aria-hidden="true" /></button>
          <button type="button" onClick={() => goTo(activeIndex + 1)} className={`${styles.controlButton} ${styles.next}`} aria-label="نمایش محصول بعدی" aria-controls={carouselId} title="محصول بعدی"><ArrowLeft size={20} aria-hidden="true" /></button>
        </div>}
        <div className={`${home.heroProduct} ${styles.captionCard}`}>
          <div className={styles.captionStage}>
            {slides.map((product, index) => {
              const active = index === activeIndex
              return <Link key={product.id} href={`/products/${encodeURIComponent(product.slug)}`} className={`${styles.captionSlide} ${active ? styles.active : ''}`} tabIndex={active ? 0 : -1} aria-hidden={!active}>
                <div className={styles.captionText}><span>{product.eyebrow}</span><h2>{product.name}</h2></div>
                <span className={home.heroProductArrow}><ArrowUpLeft size={24} aria-hidden="true" /></span>
              </Link>
            })}
          </div>
        </div>
      </div>
    </div>
  </div>
}
