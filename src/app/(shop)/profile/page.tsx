import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import ProfileClient from '@/components/shop/ProfileClient'

export default async function ProfilePage() {
  const session = await auth()

  if (!session) {
    redirect('/login')
  }

  return (
    <ProfileClient
      user={{
        name: session.user?.name ?? '',
        email: session.user?.email ?? '',
        loginPhone: session.user?.loginPhone ?? '',
        role: session.user?.role ?? 'USER',
      }}
    />
  )
}
