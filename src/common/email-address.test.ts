import { ConflictException } from '@nestjs/common'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { DrizzleQueryError } from 'drizzle-orm'
import {
  DUPLICATE_EMAIL_MESSAGE,
  NormalizeEmail,
  normalizeEmail,
  rethrowDuplicateEmail,
  translateDuplicateEmail,
} from './email-address'
import {
  PG_UNIQUE_VIOLATION,
  PRACTITIONER_LICENSE_NUMBER_UNIQUE,
  USERS_EMAIL_UNIQUE,
} from '../database/pg-errors'
import { LoginDto } from '../auth/dto/login.dto'
import { ForgotPasswordDto } from '../auth/dto/forgot-password.dto'
import { RegisterClinicDto } from '../auth/dto/register-clinic.dto'
import { CreateUserDto, UserRole } from '../users/dto/create-user.dto'

// Emails are case-insensitive (Phase 6, "Change email", pass 1): one stored
// spelling — trimmed, A–Z lowercased — applied to every email a request
// brings in, and translated into a 409 when the UNIQUE constraint finds it
// taken. The database's half (the CHECK, and that its expression agrees with
// normalizeEmail on every input) is in test/email-address.e2e-spec.ts.

describe('normalizeEmail', () => {
  it('lowercases A–Z', () => {
    expect(normalizeEmail('Pat.Smith@Stride.TEST')).toBe(
      'pat.smith@stride.test',
    )
  })

  it('removes whitespace of every kind at both ends', () => {
    expect(normalizeEmail('  pat@stride.test\t\n')).toBe('pat@stride.test')
  })

  // Only A–Z: the database's CHECK lowercases under COLLATE "C", which
  // leaves other letters alone — the two rules must agree on every input.
  it('leaves letters outside A–Z as typed', () => {
    expect(normalizeEmail('ÉMILE@Exämple.COM')).toBe('Émile@exämple.com')
  })

  it('leaves an already normal address unchanged', () => {
    expect(normalizeEmail('pat+knee_2@stride.test')).toBe(
      'pat+knee_2@stride.test',
    )
  })
})

describe('@NormalizeEmail()', () => {
  class WithEmail {
    @NormalizeEmail()
    email!: unknown
  }

  it('normalises a string while the request becomes the DTO', () => {
    const dto = plainToInstance(WithEmail, { email: ' Jane@X.com ' })
    expect(dto.email).toBe('jane@x.com')
  })

  // A number can't be trimmed; passed through, @IsEmail() refuses it with
  // its usual message instead of the request crashing in the transform.
  it('passes a value that is not a string through untouched', () => {
    const dto = plainToInstance(WithEmail, { email: 42 })
    expect(dto.email).toBe(42)
  })

  // Each DTO that receives an email carries the decorator — removing it
  // from any ONE of them must fail here. The value is also VALID only once
  // normalised (@IsEmail() refuses the spaces around it), which proves the
  // transform runs before validation.
  const typed = '  Pat@Stride.TEST '
  const cases: Array<[string, () => object]> = [
    [
      'LoginDto',
      () =>
        plainToInstance(LoginDto, { email: typed, password: 'password123' }),
    ],
    [
      'ForgotPasswordDto',
      () => plainToInstance(ForgotPasswordDto, { email: typed }),
    ],
    [
      'CreateUserDto',
      () =>
        plainToInstance(CreateUserDto, {
          email: typed,
          role: UserRole.ADMIN,
          firstName: 'Pat',
          lastName: 'Smith',
        }),
    ],
    [
      'RegisterClinicDto',
      () =>
        plainToInstance(RegisterClinicDto, {
          clinicName: 'Acme',
          clinicEmail: 'Front.Desk@Acme.test',
          email: typed,
          password: 'password123',
          firstName: 'Pat',
          lastName: 'Smith',
        }),
    ],
  ]

  it.each(cases)(
    '%s receives the email normalised, and valid',
    async (_name, build) => {
      const dto = build() as { email: string }
      expect(dto.email).toBe('pat@stride.test')
      const errors = await validate(dto)
      expect(errors.filter((error) => error.property === 'email')).toEqual([])
    },
  )

  // The clinic's CONTACT address is not a sign-in: stored as typed.
  it("leaves the clinic's contact address as typed", () => {
    const dto = cases[3][1]() as RegisterClinicDto
    expect(dto.clinicEmail).toBe('Front.Desk@Acme.test')
  })
})

describe('translateDuplicateEmail', () => {
  // node-postgres's error wrapped by drizzle — the shape the service sees.
  const uniqueViolation = (constraint: string) =>
    new DrizzleQueryError(
      'insert into "users" ...',
      [],
      Object.assign(new Error('duplicate key value'), {
        code: PG_UNIQUE_VIOLATION,
        constraint,
      }),
    )

  it("returns the write's result when it succeeds", async () => {
    await expect(
      translateDuplicateEmail(() => Promise.resolve(7)),
    ).resolves.toBe(7)
  })

  it('turns the email constraint refusing the write into a 409', async () => {
    await expect(
      translateDuplicateEmail(() =>
        Promise.reject(uniqueViolation(USERS_EMAIL_UNIQUE)),
      ),
    ).rejects.toThrow(new ConflictException(DUPLICATE_EMAIL_MESSAGE))
  })

  // Another UNIQUE (the license number) is not a taken email: its own
  // translation (UsersService) must still receive it.
  it("rethrows another constraint's refusal unchanged", async () => {
    const license = uniqueViolation(PRACTITIONER_LICENSE_NUMBER_UNIQUE)
    await expect(
      translateDuplicateEmail(() => Promise.reject(license)),
    ).rejects.toBe(license)
  })

  it('rethrows any other error unchanged', () => {
    const failure = new Error('connection terminated')
    expect(() => rethrowDuplicateEmail(failure)).toThrow(failure)
  })
})
