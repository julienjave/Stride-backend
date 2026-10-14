import { DrizzleQueryError } from 'drizzle-orm'
import {
  ASSIGNED_PROGRAM_CLOSED,
  CARE_TEAM_NO_OVERLAP,
  isCheckViolation,
  PG_CHECK_VIOLATION,
  isExclusionViolation,
  isForeignKeyViolation,
  PG_FOREIGN_KEY_VIOLATION,
  SESSIONS_WORKOUT_FK,
  isUniqueViolation,
  PG_EXCLUSION_VIOLATION,
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

describe('isExclusionViolation', () => {
  it('matches an exclusion violation on the named constraint, wrapped by drizzle', () => {
    const wrapped = new DrizzleQueryError(
      'insert into "care_team_members" ...',
      [],
      pgError(PG_EXCLUSION_VIOLATION, CARE_TEAM_NO_OVERLAP),
    )
    expect(isExclusionViolation(wrapped, CARE_TEAM_NO_OVERLAP)).toBe(true)
  })

  it('is 23P01 — the SQLSTATE Postgres uses for exclusion_violation', () => {
    expect(PG_EXCLUSION_VIOLATION).toBe('23P01')
  })

  it('does not match an exclusion violation on a DIFFERENT constraint', () => {
    expect(
      isExclusionViolation(
        pgError(PG_EXCLUSION_VIOLATION, 'other_exclusion'),
        CARE_TEAM_NO_OVERLAP,
      ),
    ).toBe(false)
  })

  // The two helpers must not be confused for each other: a unique violation
  // is not an exclusion violation, and vice versa.
  it('does not match a unique violation, and isUniqueViolation does not match it', () => {
    expect(isExclusionViolation(pgError(PG_UNIQUE_VIOLATION))).toBe(false)
    expect(isUniqueViolation(pgError(PG_EXCLUSION_VIOLATION))).toBe(false)
  })
})

describe('isForeignKeyViolation', () => {
  it('matches a foreign-key violation on the named constraint, wrapped by drizzle', () => {
    const wrapped = new DrizzleQueryError(
      'delete from "program_workouts" ...',
      [],
      pgError(PG_FOREIGN_KEY_VIOLATION, SESSIONS_WORKOUT_FK),
    )
    expect(isForeignKeyViolation(wrapped, SESSIONS_WORKOUT_FK)).toBe(true)
  })

  it('is 23503 — the SQLSTATE Postgres uses for foreign_key_violation', () => {
    expect(PG_FOREIGN_KEY_VIOLATION).toBe('23503')
  })

  it('does not match a foreign-key violation on a DIFFERENT constraint', () => {
    expect(
      isForeignKeyViolation(
        pgError(PG_FOREIGN_KEY_VIOLATION, 'other_fk'),
        SESSIONS_WORKOUT_FK,
      ),
    ).toBe(false)
  })

  it('does not match a unique violation', () => {
    expect(isForeignKeyViolation(pgError(PG_UNIQUE_VIOLATION))).toBe(false)
  })
})

describe('isCheckViolation', () => {
  // The closed-program guard (migration 0031) raises a 23514 with its own
  // constraint name: matched like a CHECK, through drizzle's wrapper.
  it('matches the closed-program refusal, wrapped by drizzle', () => {
    const wrapped = new DrizzleQueryError(
      'insert into "sessions" ...',
      [],
      pgError(PG_CHECK_VIOLATION, ASSIGNED_PROGRAM_CLOSED),
    )
    expect(isCheckViolation(wrapped, ASSIGNED_PROGRAM_CLOSED)).toBe(true)
  })

  it('is 23514 — the SQLSTATE Postgres uses for check_violation', () => {
    expect(PG_CHECK_VIOLATION).toBe('23514')
  })

  it('does not match a check violation on a DIFFERENT constraint, nor a foreign-key one', () => {
    expect(
      isCheckViolation(
        pgError(PG_CHECK_VIOLATION, 'assigned_programs_ends_after_start'),
        ASSIGNED_PROGRAM_CLOSED,
      ),
    ).toBe(false)
    expect(isCheckViolation(pgError(PG_FOREIGN_KEY_VIOLATION))).toBe(false)
  })
})
