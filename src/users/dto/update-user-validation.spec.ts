import { validate } from 'class-validator'
import { plainToInstance } from 'class-transformer'
import { UpdateUserDto } from './update-user.dto'

// UpdateUserDto is a PATCH: every field may be omitted. But "may be
// omitted" and "may be cleared" are different promises, and they must
// differ per field:
//   - NOT NULL columns (names, licenseNumber, specialties, dateOfBirth)
//     can be left out, but an explicit null or '' must be a 400 — before
//     this fix, null slipped past @IsOptional() and became a 500 from
//     Postgres's NOT NULL constraint.
//   - Nullable columns (phone, bio, position, address) CAN be cleared with
//     null — that's how the profile page removes a value.

async function errorFields(body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(UpdateUserDto, body))
  return errors.map((e) => e.property).sort()
}

describe('UpdateUserDto — required columns can be omitted, but not cleared', () => {
  it('accepts an empty body — nothing sent, nothing to validate', async () => {
    expect(await errorFields({})).toEqual([])
  })

  it.each([
    ['firstName', null],
    ['firstName', ''],
    ['lastName', null],
    ['lastName', ''],
    ['licenseNumber', null],
    ['licenseNumber', ''],
    ['specialties', null],
    ['dateOfBirth', null],
  ])('rejects %s = %j', async (field, value) => {
    expect(await errorFields({ [field]: value })).toEqual([field])
  })

  it('accepts real values for the same fields', async () => {
    expect(
      await errorFields({
        firstName: 'Jane',
        lastName: 'Doe',
        licenseNumber: 'PT-1',
        specialties: ['ortho'],
        dateOfBirth: '1990-01-01',
      }),
    ).toEqual([])
  })

  // "No specialties" is a real state — it's an empty list, not null.
  it('accepts an empty specialties list', async () => {
    expect(await errorFields({ specialties: [] })).toEqual([])
  })
})

// Checked against the same WEIGHT_UNITS list the Postgres enum is built
// from, so the database never sees a value it would reject.
describe('UpdateUserDto — preferredWeightUnit', () => {
  it.each(['kg', 'lbs'])('accepts %j', async (unit) => {
    expect(await errorFields({ preferredWeightUnit: unit })).toEqual([])
  })

  // null: the column is NOT NULL — everyone always has a preference.
  // 'KG': the check is exact; the frontend only ever sends lower case.
  it.each([null, '', 'stone', 'KG', 1])('rejects %j', async (unit) => {
    expect(await errorFields({ preferredWeightUnit: unit })).toEqual([
      'preferredWeightUnit',
    ])
  })
})

describe('UpdateUserDto — nullable columns CAN be cleared with null', () => {
  it.each(['phone', 'bio', 'position', 'addressLine2', 'addressState'])(
    'accepts %s = null',
    async (field) => {
      expect(await errorFields({ [field]: null })).toEqual([])
    },
  )

  // Clearing the whole address at once: all six fields null together is
  // what the profile page sends to remove an address.
  it('accepts every address field set to null together', async () => {
    expect(
      await errorFields({
        addressLine1: null,
        addressLine2: null,
        addressCity: null,
        addressState: null,
        addressPostalCode: null,
        addressCountry: null,
      }),
    ).toEqual([])
  })
})