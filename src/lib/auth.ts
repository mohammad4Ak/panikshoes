import NextAuth from 'next-auth'
import type {} from '@auth/core/jwt'
import CredentialsProvider from 'next-auth/providers/credentials'
import { prisma } from './prisma'
import bcrypt from 'bcryptjs'
import { SESSION_IDLE_TIMEOUT_MS, SESSION_IDLE_TIMEOUT_SECONDS } from './session-policy'
import { caseInsensitiveEmailFilter, normalizeLoginPhone } from './customer-contact'

declare module 'next-auth' {
  interface User {
    role?: string
    authVersion?: number
  }

  interface Session {
    serverTime?: number
    user: {
      id: string
      email: string
      loginPhone: string
      name: string
      role: string
    }
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    lastActivityAt?: number
    authVersion?: number
    loginPhone?: string
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        loginPhone: { label: 'Mobile number', type: 'tel' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const email = typeof credentials?.email === 'string' ? credentials.email.trim() : ''
        const loginPhone = normalizeLoginPhone(credentials?.loginPhone)
        if ((!email && !loginPhone) || (email && loginPhone) ||
            typeof credentials?.password !== 'string' || !credentials.password) return null

        const user = loginPhone
          ? await prisma.user.findUnique({ where: { loginPhone } })
          : await prisma.user.findFirst({ where: { email: caseInsensitiveEmailFilter(email) } })

        if (!user || user.isActive === false || (loginPhone && !user.phoneVerifiedAt)) {
          return null
        }

        const isPasswordValid = await bcrypt.compare(
          credentials.password,
          user.password
        )

        if (!isPasswordValid) {
          return null
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          authVersion: user.authVersion,
        }
      },
    }),
  ],
  pages: {
    signIn: '/login',
  },
  session: {
    strategy: 'jwt',
    maxAge: SESSION_IDLE_TIMEOUT_SECONDS,
  },
  jwt: {
    maxAge: SESSION_IDLE_TIMEOUT_SECONDS,
  },
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      const id = user?.id ?? token.id
      if (typeof id !== 'string' || !id) return null
      const now = Date.now()
      // Session reads roll AuthJS's cookie expiry. A separate signed timestamp
      // keeps background reads from extending the user's idle deadline.
      const lastActivityAt = user ? now : token.lastActivityAt === undefined
        ? (typeof token.iat === 'number' ? token.iat * 1000 : undefined)
        : token.lastActivityAt
      if (typeof lastActivityAt !== 'number' || !Number.isSafeInteger(lastActivityAt) ||
          lastActivityAt <= 0 || lastActivityAt > now ||
          now - lastActivityAt >= SESSION_IDLE_TIMEOUT_MS) return null
      // A JWT outlives account edits. Read the current identity on every session
      // check so deleted users and demoted admins lose access immediately.
      const currentUser = await prisma.user.findUnique({
        where: { id },
        select: { id: true, name: true, email: true, loginPhone: true, role: true, isActive: true, authVersion: true },
      })
      if (!currentUser || currentUser.isActive === false) return null
      const currentAuthVersion = currentUser.authVersion ?? 0
      // Legacy cookies are valid only until the first security change. Checking
      // the authorize-time version also closes a password-reset/login race.
      const signedAuthVersion = user ? user.authVersion ?? currentAuthVersion : token.authVersion ?? 0
      if (!Number.isSafeInteger(signedAuthVersion) || signedAuthVersion !== currentAuthVersion) return null
      token.authVersion = currentAuthVersion
      token.id = currentUser.id
      token.role = currentUser.role
      token.name = currentUser.name
      token.email = currentUser.email
      token.loginPhone = currentUser.loginPhone ?? undefined
      // Expired sessions cannot be revived. Ignore client identity/timestamps;
      // only an explicit activity update of a valid session renews the deadline.
      token.lastActivityAt = trigger === 'update' && session?.activity === true
        ? now : lastActivityAt
      return token
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string
        session.user.role = token.role as string
        session.user.name = token.name ?? ''
        session.user.email = token.email ?? ''
        session.user.loginPhone = token.loginPhone ?? ''
        return {
          ...session,
          expires: new Date(token.lastActivityAt! + SESSION_IDLE_TIMEOUT_MS).toISOString(),
          serverTime: Date.now(),
        }
      }
      return session
    },
  },
})
