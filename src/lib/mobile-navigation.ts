export type MobileNavSection = 'home' | 'shop' | 'cart' | 'account'

export function isMobileNavActive(pathname: string, section: MobileNavSection) {
  const at = (route: string) => pathname === route || pathname.startsWith(`${route}/`)
  switch (section) {
    case 'home': return pathname === '/'
    case 'shop': return at('/products')
    case 'cart': return at('/cart') || at('/checkout')
    case 'account': return at('/profile') || at('/login') || at('/register')
  }
}

export function getMobileKeyboardSnapshot() {
  if (typeof window === 'undefined' || !window.visualViewport) return false
  const target = document.activeElement as HTMLElement | null
  const editing = target?.isContentEditable || target?.tagName === 'TEXTAREA' || (
    target?.tagName === 'INPUT' &&
    ['text', 'search', 'password', 'email', 'number', 'tel', 'url'].includes((target as HTMLInputElement).type)
  )
  // A browser toolbar or pinch zoom alone must not hide navigation.
  return !!editing && window.visualViewport.scale <= 1.05 &&
    window.innerHeight - window.visualViewport.height > Math.max(150, window.innerHeight * .2)
}

export function subscribeToMobileKeyboard(onChange: () => void) {
  const viewport = window.visualViewport
  let subscribed = true
  // focusout fires before activeElement has moved to its next target.
  const onFocus = () => queueMicrotask(() => { if (subscribed) onChange() })
  viewport?.addEventListener('resize', onChange)
  window.addEventListener('resize', onChange)
  document.addEventListener('focusin', onFocus)
  document.addEventListener('focusout', onFocus)
  return () => {
    subscribed = false
    viewport?.removeEventListener('resize', onChange)
    window.removeEventListener('resize', onChange)
    document.removeEventListener('focusin', onFocus)
    document.removeEventListener('focusout', onFocus)
  }
}

export const getMobileKeyboardServerSnapshot = () => false
