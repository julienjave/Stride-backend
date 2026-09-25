import { DrizzleQueryError } from 'drizzle-orm'
import {
  isUniqueViolation,
  PG_UNIQUE_VIOLATION,
  PRACTITIONER_LICENSE_NUMBER_UNIQUE,
} from './pg-errors'

// A stand-in for node-postgres's DatabaseError: a real Error carrying the
// two fields Postgres fills in on a constraint failure.
function pgError(code: string, constraint?: string) {
  return Object.assign(new Error('pg error'), { code, constraint })
}

describe('isUniqueViolation', () => {
  it('matches a bare unique violation on the named constraint', () => {
    const error = pgError(
      PG_UNIQUE_VIOLATION,
      PRACTITIONER_LICENSE_NUMBER_UNIQUE,
    )
    expect(isUniqueViolation(error, PRACTITIONER_LICENSE_NUMBER_UNIQUE)).toBe(
      true,
    )
  })

  // The shape a real query failure actually arrives in: drizzle wraps the
  // driver error and keeps it in `.cause`. Built with drizzle's REAL error
  // class, so a future drizzle change to how it wraps errors fails here.
  it('matches when drizzle has wrapped the driver error in DrizzleQueryError', () => {
    const wrapped = new DrizzleQueryError(
      'update "practitioner_profiles" set ...',
      [],
      pgError(PG_UNIQUE_VIOLATION, PRACTITIONER_LICENSE_NUMBER_UNIQUE),
    )
    expect(isUniqueViolation(wrapped, PRACTITIONER_LICENSE_NUMBER_UNIQUE)).toBe(
      true,
    )
  })

  it('does not match a unique violation on a DIFFERENT constraint', () => {
    const error = pgError(PG_UNIQUE_VIOLATION, 'users_email_unique')
    expect(isUniqueViolation(error, PRACTITIONER_LICENSE_NUMBER_UNIQUE)).toBe(
      false,
    )
  })

  it('matches any unique violation when no constraint is named', () => {
    expect(
      isUniqueViolation(pgError(PG_UNIQUE_VIOLATION, 'users_email_unique')),
    ).toBe(true)
  })

  it('does not match other Postgres errors (23502 = not_null_violation)', () => {
    expect(isUniqueViolation(pgError('23502'))).toBe(false)
  })

  it('does not match plain errors, non-objects, or nothing at all', () => {
    expect(isUniqueViolation(new Error('boom'))).toBe(false)
    expect(isUniqueViolation('23505')).toBe(false)
    expect(isUniqueViolation(undefined)).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
  })
})