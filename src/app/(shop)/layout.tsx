import Header from '@/components/layout/Header'
import Footer from '@/components/layout/Footer'
import ShopMotion from '@/components/shop/ShopMotion'
import VisitTracker from '@/components/shop/VisitTracker'
import AnnouncementBar from '@/components/layout/AnnouncementBar'
import mobileNavStyles from '@/components/layout/mobile-bottom-nav.module.css'

export default function ShopLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <ShopMotion>
      <VisitTracker />
      <AnnouncementBar />
      <Header />
      <main className="min-w-0 flex-1">{children}</main>
      <Footer />
      <div className={mobileNavStyles.spacer} aria-hidden="true" />
    </ShopMotion>
  )
}
