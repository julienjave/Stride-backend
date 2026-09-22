import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { AddTemplateExerciseDto } from "../../programs/dto/add-template-exercise.dto";
import { AssignedExerciseInputDto } from "../../assigned-programs/dto/assigned-exercise-input.dto";

function errorFieldNames(errors: { property: string }[]) {
  return errors.map((e) => e.property).sort();
}

// Both DTOs share the exact same weight/weightUnit shape (same
// decorators, same hasStartedWeight rule) — tested together via
// describe.each rather than duplicating every case twice, since a
// divergence between them would be exactly the kind of drift
// hasStartedWeight being a single shared function is meant to prevent.
describe.each([
  ["AddTemplateExerciseDto", AddTemplateExerciseDto],
  ["AssignedExerciseInputDto", AssignedExerciseInputDto],
])("Weight validation — %s", (_name, DtoClass) => {
  const baseFields = { exerciseId: 1, sortOrder: 0 };

  it("passes with neither weight nor weightUnit — both optional together", async () => {
    const dto = plainToInstance(DtoClass, { ...baseFields });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("passes with a valid weight and weightUnit together", async () => {
    const dto = plainToInstance(DtoClass, {
      ...baseFields,
      weight: 62.5,
      weightUnit: "kg",
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("fails when weight is given but weightUnit is missing", async () => {
    const dto = plainToInstance(DtoClass, { ...baseFields, weight: 62.5 });
    const errors = await validate(dto);
    expect(errorFieldNames(errors)).toEqual(["weightUnit"]);
  });

  it("fails when weightUnit is given but weight is missing", async () => {
    const dto = plainToInstance(DtoClass, {
      ...baseFields,
      weightUnit: "kg",
    });
    const errors = await validate(dto);
    expect(errorFieldNames(errors)).toEqual(["weight"]);
  });

  it("accepts a weight of exactly 0, as long as a unit is given too", async () => {
    const dto = plainToInstance(DtoClass, {
      ...baseFields,
      weight: 0,
      weightUnit: "kg",
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("rejects a negative weight", async () => {
    const dto = plainToInstance(DtoClass, {
      ...baseFields,
      weight: -5,
      weightUnit: "kg",
    });
    const errors = await validate(dto);
    expect(errorFieldNames(errors)).toEqual(["weight"]);
  });

  it("rejects a weightUnit that isn't kg or lbs", async () => {
    const dto = plainToInstance(DtoClass, {
      ...baseFields,
      weight: 50,
      weightUnit: "stone",
    });
    const errors = await validate(dto);
    expect(errorFieldNames(errors)).toEqual(["weightUnit"]);
  });

  it("accepts up to 2 decimal places", async () => {
    const dto = plainToInstance(DtoClass, {
      ...baseFields,
      weight: 61.25,
      weightUnit: "lbs",
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("rejects more than 2 decimal places — false precision, not a real plate increment", async () => {
    const dto = plainToInstance(DtoClass, {
      ...baseFields,
      weight: 62.555,
      weightUnit: "kg",
    });
    const errors = await validate(dto);
    expect(errorFieldNames(errors)).toEqual(["weight"]);
  });
});