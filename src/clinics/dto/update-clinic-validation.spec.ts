import { validate } from 'class-validator'
import { plainToInstance } from 'class-transformer'
import { UpdateClinicDto } from './update-clinic.dto'

// name and email are NOT NULL columns: a PATCH may leave them out, but
// never clear them. Everything else may be cleared with null.
async function errorFields(body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(UpdateClinicDto, body))
  return errors.map((e) => e.property).sort()
}

describe('UpdateClinicDto', () => {
  it('accepts an empty body', async () => {
    expect(await errorFields({})).toEqual([])
  })

  it.each([
    ['name', null],
    ['name', ''],
    ['email', null],
    ['email', 'not-an-email'],
  ])('rejects %s = %j', async (field, value) => {
    expect(await errorFields({ [field]: value })).toEqual([field])
  })

  it('accepts real values for name and email', async () => {
    expect(
      await errorFields({ name: 'Acme', email: 'acme@example.com' }),
    ).toEqual([])
  })

  it('still accepts null for the clearable fields — phone, website, the whole address', async () => {
    expect(
      await errorFields({
        phone: null,
        website: null,
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
