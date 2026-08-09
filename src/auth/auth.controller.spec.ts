import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants'
import { AuthController } from './auth.controller'

// Pins the fix: mfa/enable and mfa/disable used to fall back to the global
// 60/min-per-IP throttle while mfa/verify had its own tighter @Throttle(5,
// 60) — inconsistent with the app's own rationale for requiring a fresh
// code on sensitive MFA actions. Reflection, not an e2e 429 trip, because
// the e2e suite deliberately avoids exhausting shared per-IP throttle
// budgets across tests (see the login-throttle comment in
// messaging-gateway.e2e-spec.ts) — this asserts the same decorator config
// without spending any of that budget.
describe('AuthController MFA route throttling', () => {
  const readThrottle = (fn: (...args: never[]) => unknown) => ({
    limit: Reflect.getMetadata(THROTTLER_LIMIT + 'default', fn) as number | undefined,
    ttl: Reflect.getMetadata(THROTTLER_TTL + 'default', fn) as number | undefined,
  })

  it('applies the same throttle to mfa/enable and mfa/disable as mfa/verify', () => {
    const verifyThrottle = readThrottle(AuthController.prototype.verifyMfaLogin)
    expect(verifyThrottle.limit).toBe(5)
    expect(verifyThrottle.ttl).toBeDefined()

    expect(readThrottle(AuthController.prototype.enableMfa)).toEqual(verifyThrottle)
    expect(readThrottle(AuthController.prototype.disableMfa)).toEqual(verifyThrottle)
  })
})
