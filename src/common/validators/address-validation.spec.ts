import { validate } from 'class-validator'
import { plainToInstance } from 'class-transformer'
import { CreateClinicDto } from '../../clinics/dto/create-clinic.dto'
import { UpdateUserDto } from '../../users/dto/update-user.dto'

// A full, valid address — used as the base for the "core fields required
// together" tests below, tweaked field by field.
const fullAddress = {
  addressLine1: '1 Acme Way',
  addressLine2: 'Suite 200',
  addressCity: 'Springfield',
  addressState: 'IL',
  addressPostalCode: '62704',
  addressCountry: 'US',
}

function errorFieldNames(errors: { property: string }[]) {
  return errors.map((e) => e.property).sort()
}

describe('Address validation — create-style DTOs (CreateClinicDto)', () => {
  it('passes with no address at all — the whole block is optional', async () => {
    const dto = plainToInstance(CreateClinicDto, {
      name: 'Acme Clinic',
      email: 'acme@example.com',
    })

    const errors = await validate(dto)

    expect(errors).toHaveLength(0)
  })

  it('passes with a complete address, including the optional line2/state', async () => {
    const dto = plainToInstance(CreateClinicDto, {
      name: 'Acme Clinic',
      email: 'acme@example.com',
      ...fullAddress,
    })

    const errors = await validate(dto)

    expect(errors).toHaveLength(0)
  })

  it('passes with a complete address MINUS the optional state — state is not core', async () => {
    const { addressState: _addressState, ...withoutState } = fullAddress
    const dto = plainToInstance(CreateClinicDto, {
      name: 'Acme Clinic',
      email: 'acme@example.com',
      ...withoutState,
    })

    const errors = await validate(dto)

    expect(errors).toHaveLength(0)
  })

  it('fails when a core field is given but the others are missing', async () => {
    const dto = plainToInstance(CreateClinicDto, {
      name: 'Acme Clinic',
      email: 'acme@example.com',
      addressCity: 'Springfield', // only this one core field
    })

    const errors = await validate(dto)

    // addressLine1, addressPostalCode, addressCountry should all be
    // flagged — addressCity itself is fine, addressLine2/addressState
    // are non-core so they're never flagged.
    expect(errorFieldNames(errors)).toEqual([
      'addressCountry',
      'addressLine1',
      'addressPostalCode',
    ])
  })

  it('fails when the country is the wrong length', async () => {
    const dto = plainToInstance(CreateClinicDto, {
      name: 'Acme Clinic',
      email: 'acme@example.com',
      ...fullAddress,
      addressCountry: 'USA', // 3 characters, not the required 2
    })

    const errors = await validate(dto)

    expect(errorFieldNames(errors)).toEqual(['addressCountry'])
  })
})

describe('Address validation — update-style DTOs (UpdateUserDto)', () => {
  it('passes when patching an unrelated field with no address fields at all', async () => {
    const dto = plainToInstance(UpdateUserDto, { firstName: 'Jamie' })

    const errors = await validate(dto)

    expect(errors).toHaveLength(0)
  })

  it('passes for a genuine SINGLE-field address patch — this is the whole point of IsOptional here', async () => {
    // Only addressCity is being changed; addressLine1/addressPostalCode/
    // addressCountry are simply not part of this request at all. If
    // UpdateUserDto's core address fields were missing @IsOptional
    // alongside @ValidateIf, this would incorrectly fail.
    const dto = plainToInstance(UpdateUserDto, { addressCity: 'New City' })

    const errors = await validate(dto)

    expect(errors).toHaveLength(0)
  })

  it('fails when one core field is patched but another is explicitly sent empty', async () => {
    const dto = plainToInstance(UpdateUserDto, {
      addressCity: 'New City',
      addressCountry: '', // explicitly cleared, not just omitted
    })

    const errors = await validate(dto)

    expect(errorFieldNames(errors)).toEqual(['addressCountry'])
  })

  it('passes when patching a complete address', async () => {
    const dto = plainToInstance(UpdateUserDto, fullAddress)

    const errors = await validate(dto)

    expect(errors).toHaveLength(0)
  })
})