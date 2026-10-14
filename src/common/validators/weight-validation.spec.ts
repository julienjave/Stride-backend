import { validate } from 'class-validator'
import { plainToInstance } from 'class-transformer'
import { AddTemplateExerciseDto } from '../../programs/dto/add-template-exercise.dto'
import { AssignedExerciseInputDto } from '../../assigned-programs/dto/assigned-exercise-input.dto'
import { UpdateAssignedProgramExerciseDto } from '../../assigned-programs/dto/update-assigned-program-exercise.dto'
import { UpdateTemplateExerciseDto } from '../../programs/dto/update-template-exercise.dto'

function errorFieldNames(errors: { property: string }[]) {
  return errors.map((e) => e.property).sort()
}

// All four DTOs share the exact same weight/weightUnit shape (same
// decorators, same hasStartedWeight rule) — tested together via
// describe.each rather than duplicating every case three times, since a
// divergence between them would be exactly the kind of drift
// hasStartedWeight being a single shared function is meant to prevent.
// UpdateAssignedProgramExerciseDto is included even though it's no
// longer derived from AssignedExerciseInputDto (see that file's own
// comment on why) — its weight/weightUnit fields are now an independent
// copy, not inherited, so nothing guarantees they behave identically
// just because the other two do.
//
// UpdateTemplateExerciseDto was MISSING from this list until 2026-09-23 —
// and it was the one DTO that didn't actually follow the rule (see its
// own comment: PartialType's @IsOptional() was overriding the
// both-or-neither check). Adding it here is what proves the fix, and
// keeps it proven.
describe.each([
  ['AddTemplateExerciseDto', AddTemplateExerciseDto],
  ['AssignedExerciseInputDto', AssignedExerciseInputDto],
  ['UpdateAssignedProgramExerciseDto', UpdateAssignedProgramExerciseDto],
  ['UpdateTemplateExerciseDto', UpdateTemplateExerciseDto],
])('Weight validation — %s', (name, DtoClass) => {
  // The two UPDATE dtos have no required exerciseId/sortOrder (a PATCH
  // only touches what's provided) — the two creation dtos require both.
  const baseFields = name.startsWith('Update')
    ? {}
    : { exerciseId: 1, sortOrder: 0 }

  // describe.each infers DtoClass as a UNION of all three constructor
  // types in the array above — correct for what the array actually
  // holds, but plainToInstance's own generic signature expects one
  // SPECIFIC class matching the object being transformed, not a union
  // of possibly-different ones, so TypeScript (correctly) refuses it
  // directly. The cast here says what's actually true at runtime: on
  // any given iteration, DtoClass is one real, specific class — just
  // not one TypeScript can narrow to from a mixed array's inferred type.
  function makeDto(fields: Record<string, unknown>) {
    return plainToInstance(DtoClass as new () => object, {
      ...baseFields,
      ...fields,
    })
  }

  it('passes with neither weight nor weightUnit — both optional together', async () => {
    const dto = makeDto({})
    const errors = await validate(dto)
    expect(errors).toHaveLength(0)
  })

  it('passes with a valid weight and weightUnit together', async () => {
    const dto = makeDto({ weight: 62.5, weightUnit: 'kg' })
    const errors = await validate(dto)
    expect(errors).toHaveLength(0)
  })

  it('fails when weight is given but weightUnit is missing', async () => {
    const dto = makeDto({ weight: 62.5 })
    const errors = await validate(dto)
    expect(errorFieldNames(errors)).toEqual(['weightUnit'])
  })

  it('fails when weightUnit is given but weight is missing', async () => {
    const dto = makeDto({ weightUnit: 'kg' })
    const errors = await validate(dto)
    expect(errorFieldNames(errors)).toEqual(['weight'])
  })

  it('accepts a weight of exactly 0, as long as a unit is given too', async () => {
    const dto = makeDto({ weight: 0, weightUnit: 'kg' })
    const errors = await validate(dto)
    expect(errors).toHaveLength(0)
  })

  it('rejects a negative weight', async () => {
    const dto = makeDto({ weight: -5, weightUnit: 'kg' })
    const errors = await validate(dto)
    expect(errorFieldNames(errors)).toEqual(['weight'])
  })

  it("rejects a weightUnit that isn't kg or lbs", async () => {
    const dto = makeDto({ weight: 50, weightUnit: 'stone' })
    const errors = await validate(dto)
    expect(errorFieldNames(errors)).toEqual(['weightUnit'])
  })

  it('accepts up to 2 decimal places', async () => {
    const dto = makeDto({ weight: 61.25, weightUnit: 'lbs' })
    const errors = await validate(dto)
    expect(errors).toHaveLength(0)
  })

  it('rejects more than 2 decimal places — false precision, not a real plate increment', async () => {
    const dto = makeDto({ weight: 62.555, weightUnit: 'kg' })
    const errors = await validate(dto)
    expect(errorFieldNames(errors)).toEqual(['weight'])
  })

  // --- null: how a weight is CLEARED ---------------------------------------

  it('passes with both explicitly null — the way a weight is cleared', async () => {
    const dto = makeDto({ weight: null, weightUnit: null })
    const errors = await validate(dto)
    expect(errors).toHaveLength(0)
  })

  it('rejects clearing only the weight while keeping a unit', async () => {
    const dto = makeDto({ weight: null, weightUnit: 'kg' })
    const errors = await validate(dto)
    expect(errorFieldNames(errors)).toEqual(['weight'])
  })

  it('rejects clearing only the unit while keeping a weight', async () => {
    const dto = makeDto({ weight: 62.5, weightUnit: null })
    const errors = await validate(dto)
    expect(errorFieldNames(errors)).toEqual(['weightUnit'])
  })
})
