import NextAuth from 'next-auth'
import type {} from '@auth/core/jwt'
import CredentialsProvider from 'next-auth/providers/credentials'
import { prisma } from './prisma'
import bcrypt from 'bcryptjs'
import { SESSION_IDLE_TIMEOUT_MS, SESSION_IDLE_TIMEOUT_SECONDS } from './session-policy'

declare module 'next-auth' {
  interface User {
    role?: string
  }

  interface Session {
    serverTime?: number
    user: {
      id: string
      email: string
      name: string
      role: string
    }
  }
}

declare module '@auth/core/jwt' {
  interface JWT {
    lastActivityAt?: number
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (typeof credentials?.email !== 'string' || typeof credentials?.password !== 'string' ||
            !credentials.email.trim() || !credentials.password) {
          return null
        }

        const user = await prisma.user.findFirst({
          where: { email: { equals: credentials.email.trim(), mode: 'insensitive' } },
        })

        if (!user) {
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
        select: { id: true, name: true, email: true, role: true },
      })
      if (!currentUser) return null
      token.id = currentUser.id
      token.role = currentUser.role
      token.name = currentUser.name
      token.email = currentUser.email
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
