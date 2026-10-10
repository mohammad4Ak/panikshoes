import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import AdminShell from '@/components/admin/AdminShell'

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth()

  // بدون لاگین -> صفحه ورود
  if (!session) {
    redirect('/login')
  }

  // کاربر عادی -> فروشگاه (بدون رندر حتی یک خط از پنل)
  if (session.user?.role !== 'ADMIN') {
    redirect('/')
  }

  return <AdminShell userName={session.user?.name}>{children}</AdminShell>
}