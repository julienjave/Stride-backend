/*
    Copyright 2026 Julien Javelaud

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/
// -----------------------------------------------------------------------------------------------------------

import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { UpdateAssignedProgramExerciseDto } from "./update-assigned-program-exercise.dto";

function errorFieldNames(errors: { property: string }[]) {
  return errors.map((e) => e.property).sort();
}

// These fields didn't exist on this DTO before the exercise-snapshotting
// work — an assigned program's exercise now carries its own independent
// copy of name/primaryMuscles/secondaryMuscles/equipment/instructions,
// editable per patient. Same real-world minimums as CreateExerciseDto
// (an exercise with zero primary muscles or zero instructions isn't a
// meaningfully valid state, whether it's the shared original or a
// per-patient copy), tested directly against the real class-validator
// engine rather than assumed from CreateExerciseDto's own coverage,
// since these are now an independent copy of the decorators, not shared.
describe("UpdateAssignedProgramExerciseDto — snapshot field validation", () => {
  it("passes with none of the snapshot fields provided — a PATCH only touching prescription fields", async () => {
    const dto = plainToInstance(UpdateAssignedProgramExerciseDto, {
      sets: 3,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("passes with all snapshot fields provided validly", async () => {
    const dto = plainToInstance(UpdateAssignedProgramExerciseDto, {
      name: "Modified Squat",
      primaryMuscles: ["legs"],
      secondaryMuscles: ["core"],
      equipment: ["barbell"],
      instructions: ["Step one", "Step two"],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("rejects an empty primaryMuscles array", async () => {
    const dto = plainToInstance(UpdateAssignedProgramExerciseDto, {
      primaryMuscles: [],
    });
    const errors = await validate(dto);
    expect(errorFieldNames(errors)).toEqual(["primaryMuscles"]);
  });

  it("rejects an empty instructions array", async () => {
    const dto = plainToInstance(UpdateAssignedProgramExerciseDto, {
      instructions: [],
    });
    const errors = await validate(dto);
    expect(errorFieldNames(errors)).toEqual(["instructions"]);
  });

  it("accepts an empty secondaryMuscles array — genuinely optional, unlike primaryMuscles", async () => {
    const dto = plainToInstance(UpdateAssignedProgramExerciseDto, {
      secondaryMuscles: [],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("accepts an empty equipment array — genuinely optional", async () => {
    const dto = plainToInstance(UpdateAssignedProgramExerciseDto, {
      equipment: [],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("rejects a name longer than 255 characters", async () => {
    const dto = plainToInstance(UpdateAssignedProgramExerciseDto, {
      name: "a".repeat(256),
    });
    const errors = await validate(dto);
    expect(errorFieldNames(errors)).toEqual(["name"]);
  });

  it("rejects an instruction step longer than 500 characters", async () => {
    const dto = plainToInstance(UpdateAssignedProgramExerciseDto, {
      instructions: ["a".repeat(501)],
    });
    const errors = await validate(dto);
    expect(errorFieldNames(errors)).toEqual(["instructions"]);
  });

  it("rejects a primary muscle longer than 100 characters", async () => {
    const dto = plainToInstance(UpdateAssignedProgramExerciseDto, {
      primaryMuscles: ["a".repeat(101)],
    });
    const errors = await validate(dto);
    expect(errorFieldNames(errors)).toEqual(["primaryMuscles"]);
  });
});