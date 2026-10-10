const revealSelector = '[data-reveal]'
const settledElements = new WeakSet<HTMLElement>()

/** Native animations never mutate attributes belonging to a hydrating React tree. */
export function observeShopMotion(root: HTMLElement) {
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
  const registered = new Map<HTMLElement, Animation | null>()
  const pending = new Set<HTMLElement>()
  let intersection: IntersectionObserver | null = null
  let mutations: MutationObserver | null = null
  let disposed = false

  function cancel(element: HTMLElement) {
    const animation = registered.get(element)
    if (animation) {
      animation.onfinish = null
      animation.cancel()
    }
    registered.set(element, null)
    pending.delete(element)
    intersection?.unobserve(element)
  }

  function show(element: HTMLElement) {
    cancel(element)
    settledElements.add(element)
  }

  function register(element: HTMLElement) {
    if (registered.has(element)) return
    const bounds = element.getBoundingClientRect()
    // Never fade the current viewport, restored scroll position, or focused UI.
    if (!intersection || preference.matches || settledElements.has(element)
      || typeof element.animate !== 'function' || bounds.top < window.innerHeight - 24
      || element.contains(document.activeElement)) {
      show(element)
      return
    }
    const delay = Math.min(3, Math.max(0, Number(element.dataset.revealDelay) || 0)) * 55
    try {
      const animation = element.animate([
        { opacity: 0, translate: '0 18px' },
        { opacity: 1, translate: '0 0' },
      ], { duration: 580, delay, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'both' })
      registered.set(element, animation)
      animation.pause()
      animation.currentTime = 0
    } catch {
      // A browser without support for these keyframes still shows all content.
      show(element)
      return
    }
    pending.add(element)
    intersection.observe(element)
  }

  function scan(element: HTMLElement) {
    if (element.matches(revealSelector)) register(element)
    element.querySelectorAll<HTMLElement>(revealSelector).forEach(register)
  }

  function stop(settlePending = true) {
    intersection?.disconnect()
    mutations?.disconnect()
    intersection = null
    mutations = null
    for (const element of registered.keys()) {
      if (settlePending || !pending.has(element)) settledElements.add(element)
      cancel(element)
    }
  }

  function start() {
    if (preference.matches || !('IntersectionObserver' in window) || !('MutationObserver' in window)) {
      scan(root)
      return
    }
    intersection = new IntersectionObserver((entries) => {
      if (disposed) return
      for (const entry of entries) {
        const element = entry.target as HTMLElement
        if (!entry.isIntersecting || !pending.has(element) || !root.contains(element)) continue
        const animation = registered.get(element)
        pending.delete(element)
        settledElements.add(element)
        intersection?.unobserve(element)
        if (animation) {
          animation.onfinish = () => show(element)
          animation.play()
        }
      }
    }, { rootMargin: '0px 0px -24px 0px', threshold: 0 })
    scan(root)
    mutations = new MutationObserver((records) => {
      if (disposed) return
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement) scan(node)
        }
      }
      for (const element of registered.keys()) {
        if (!root.contains(element)) {
          show(element)
          registered.delete(element)
        }
      }
    })
    mutations.observe(root, { childList: true, subtree: true })
  }

  function onPreferenceChange() {
    stop()
    start()
  }

  function onFocus(event: FocusEvent) {
    if (!(event.target instanceof HTMLElement)) return
    let element: HTMLElement | null = event.target
    while (element && root.contains(element)) {
      if (element.matches(revealSelector)) show(element)
      element = element.parentElement
    }
  }

  function onPrint() { stop() }

  start()
  preference.addEventListener('change', onPreferenceChange)
  root.addEventListener('focusin', onFocus)
  window.addEventListener('beforeprint', onPrint)
  return () => {
    disposed = true
    // Unplayed entries can be armed again after StrictMode's effect replay.
    stop(false)
    preference.removeEventListener('change', onPreferenceChange)
    root.removeEventListener('focusin', onFocus)
    window.removeEventListener('beforeprint', onPrint)
  }
}
