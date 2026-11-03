/*
    Copyright 2026 Julien Javelaud

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/
// -----------------------------------------------------------------------------------------------------------

import { Controller, Get, HttpCode, Req } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import type { Request } from 'express'
import session from 'express-session'
import request from 'supertest'
import { UserRole } from '../users/dto/create-user.dto'
import { SESSION_MAX_AGE_MS, sessionCookieOptions } from './session-cookie'

// The options run through the REAL express-session middleware, in a real
// Nest app, as main.ts uses it — and the test reads the Set-Cookie header a
// browser receives: what the browser obeys, not what an object literal
// contains. The store is express-session's default memory store: where the
// session is kept doesn't change the cookie's attributes.

// One route that puts something in the session: with saveUninitialized
// false (main.ts's setting), an untouched session sends no cookie at all.
// `mfaPending` is one of the app's own session fields
// (auth/express-session.d.ts), so the write is typed.
@Controller()
class SignInController {
  @Get('sign-in')
  @HttpCode(204)
  signIn(@Req() req: Request) {
    req.session.mfaPending = { userId: 1, activeRole: UserRole.PATIENT }
  }
}

async function appWith(env: NodeJS.ProcessEnv) {
  const moduleRef = await Test.createTestingModule({
    controllers: [SignInController],
  }).compile()
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: false,
  })
  // As in production, the app sits behind a proxy that ends HTTPS (Caddy,
  // after Cloudflare). express-session sends a Secure cookie only on a
  // request it believes is secure, which behind a proxy it learns from
  // X-Forwarded-Proto — read only when the proxy is trusted.
  app.set('trust proxy', 1)
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
      cookie: sessionCookieOptions(env),
    }),
  )
  await app.init()
  return app
}

// The session cookie, split into its attributes ("HttpOnly", "SameSite=Lax"…).
function cookieAttributes(setCookie: string[] | string | undefined) {
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? '']
  const sessionCookie = cookies.find((c) => c.startsWith('connect.sid='))
  expect(sessionCookie).toBeDefined()
  return (sessionCookie ?? '')
    .split(';')
    .slice(1)
    .map((part) => part.trim())
}

describe('sessionCookieOptions', () => {
  let app: NestExpressApplication | undefined

  afterEach(async () => {
    await app?.close()
    app = undefined
  })

  // Returns the SERVER, not the request: supertest's request is a
  // thenable, so an async function returning it would send it at once —
  // before the test could add a header.
  const serverFor = async (env: NodeJS.ProcessEnv) => {
    app = await appWith(env)
    return app.getHttpServer()
  }

  it('in production: HttpOnly, Secure, SameSite=Lax, 7 days', async () => {
    const response = await request(await serverFor({ NODE_ENV: 'production' }))
      .get('/sign-in')
      .set('X-Forwarded-Proto', 'https')
      .expect(204)
    const attributes = cookieAttributes(response.headers['set-cookie'])
    expect(attributes).toContain('HttpOnly')
    expect(attributes).toContain('Secure')
    expect(attributes).toContain('SameSite=Lax')
    // express-session turns maxAge into an Expires date (no Max-Age
    // attribute): 7 days from now, to the second the header can say.
    const expires = attributes.find((a) => a.startsWith('Expires='))
    const expiresAt = Date.parse((expires ?? '').slice('Expires='.length))
    expect(
      Math.abs(expiresAt - (Date.now() + SESSION_MAX_AGE_MS)),
    ).toBeLessThan(5_000)
    // Exactly one SameSite: the attribute that used to be None is gone,
    // not joined by a second one.
    expect(attributes.filter((a) => a.startsWith('SameSite='))).toStrictEqual([
      'SameSite=Lax',
    ])
  })

  // Development runs on plain http://localhost: a Secure cookie would never
  // be sent back, and nobody could stay signed in.
  it('in development: SameSite=Lax too, without Secure', async () => {
    const response = await request(await serverFor({ NODE_ENV: 'development' }))
      .get('/sign-in')
      .expect(204)
    const attributes = cookieAttributes(response.headers['set-cookie'])
    expect(attributes).toContain('HttpOnly')
    expect(attributes).toContain('SameSite=Lax')
    expect(attributes).not.toContain('Secure')
  })

  // The neighbour, and what `secure` means: in production a request that
  // arrived over plain HTTP gets no cookie at all — express-session refuses
  // to send a Secure cookie on a connection that isn't.
  it('in production, sends no cookie on a request that came over plain HTTP', async () => {
    const response = await request(await serverFor({ NODE_ENV: 'production' }))
      .get('/sign-in')
      .set('X-Forwarded-Proto', 'http')
      .expect(204)
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('lasts 7 days', () => {
    expect(SESSION_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})
