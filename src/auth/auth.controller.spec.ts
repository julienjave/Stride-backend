import {
  THROTTLER_LIMIT,
  THROTTLER_TTL,
} from '@nestjs/throttler/dist/throttler.constants'
import { AuthController } from './auth.controller'
import { MfaController } from '../mfa/mfa.controller'

// Pins the fix: mfa/enable and mfa/disable used to fall back to the global
// 60/min-per-IP throttle while mfa/verify had its own tighter @Throttle(5,
// 60) — inconsistent with the app's own rationale for requiring a fresh
// code on sensitive MFA actions. Since MFA enrolment, setup, enable and
// disable live in MfaController (same addresses), and setup is held to the
// same limit: it now checks the current password. Reflection, not an e2e 429 trip, because
// the e2e suite deliberately avoids exhausting shared per-IP throttle
// budgets across tests (see the login-throttle comment in
// messaging-gateway.e2e-spec.ts) — this asserts the same decorator config
// without spending any of that budget.
describe('AuthController MFA route throttling', () => {
  // @Throttle writes its metadata on the method's FUNCTION OBJECT — the
  // property descriptor's `value` (see @nestjs/throttler's
  // throttler.decorator.js). So the test reads it from the descriptor,
  // rather than writing `MfaController.prototype.enable` as a value:
  // that is what lint's unbound-method warns about (a method taken off its
  // object loses `this` if it's ever CALLED). Nothing is called here — and
  // now the code says so.
  // Typed per controller: a method name that doesn't exist on the class is a
  // compile error, not a test reading `undefined`.
  function readThrottle<C extends { prototype: object; name: string }>(
    controller: C,
    method: keyof C['prototype'] & string,
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(
      controller.prototype,
      method,
    )
    if (!descriptor) throw new Error(`${controller.name} has no ${method}`)
    const handler = descriptor.value as object
    return {
      limit: Reflect.getMetadata(THROTTLER_LIMIT + 'default', handler) as
        number | undefined,
      ttl: Reflect.getMetadata(THROTTLER_TTL + 'default', handler) as
        number | undefined,
    }
  }

  // The reset link's pre-check is a public yes/no about a token: the same
  // tight limit as the reset itself.
  it('applies the reset-password throttle to reset-password/check', () => {
    expect(readThrottle(AuthController, 'resetPassword').limit).toBe(5)
    expect(readThrottle(AuthController, 'checkResetToken')).toEqual(
      readThrottle(AuthController, 'resetPassword'),
    )
  })

  it('applies the same throttle to mfa/setup, mfa/enable and mfa/disable as mfa/verify', () => {
    const verifyThrottle = readThrottle(AuthController, 'verifyMfaLogin')
    expect(verifyThrottle.limit).toBe(5)
    expect(verifyThrottle.ttl).toBeDefined()

    expect(readThrottle(MfaController, 'setup')).toEqual(verifyThrottle)
    expect(readThrottle(MfaController, 'enable')).toEqual(verifyThrottle)
    expect(readThrottle(MfaController, 'disable')).toEqual(verifyThrottle)
  })
})
