import { signIn, signOut } from 'next-auth/react'
import { withSessionLock } from './session-client'

export function signInWithSessionLock(provider: 'credentials', options: {
  email: string
  password: string
  redirect: false
}) {
  return withSessionLock(() => signIn(provider, options))
}

export function signOutWithSessionLock(options: { redirectTo: string }) {
  return withSessionLock(() => signOut(options))
}
