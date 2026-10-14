import { hasStartedAddress } from './has-started-address'

describe('hasStartedAddress', () => {
  it('returns false when none of the core fields are set', () => {
    expect(hasStartedAddress({})).toBe(false)
  })

  it('returns true when any single core field is set', () => {
    expect(hasStartedAddress({ addressLine1: '1 Acme Way' })).toBe(true)
    expect(hasStartedAddress({ addressCity: 'Springfield' })).toBe(true)
    expect(hasStartedAddress({ addressPostalCode: '62704' })).toBe(true)
    expect(hasStartedAddress({ addressCountry: 'US' })).toBe(true)
  })

  it('ignores addressLine2 and addressState — neither is a core field', () => {
    expect(hasStartedAddress({ addressLine2: 'Suite 200' })).toBe(false)
  })

  it('returns false for an empty-string core field, same as absent', () => {
    expect(hasStartedAddress({ addressLine1: '' })).toBe(false)
  })
})
