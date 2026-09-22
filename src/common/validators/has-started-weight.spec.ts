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

import { hasStartedWeight } from "./has-started-weight";

describe("hasStartedWeight", () => {
  it("returns false when neither field is present", () => {
    expect(hasStartedWeight({})).toBe(false);
  });

  it("returns true when only weight is present", () => {
    expect(hasStartedWeight({ weight: 62.5 })).toBe(true);
  });

  it("returns true when only weightUnit is present", () => {
    expect(hasStartedWeight({ weightUnit: "kg" })).toBe(true);
  });

  it("returns true when both are present", () => {
    expect(hasStartedWeight({ weight: 62.5, weightUnit: "kg" })).toBe(true);
  });

  // The whole reason this uses `!== undefined` rather than `!!` — a
  // falsy-but-real weight value must still count as "started," or a
  // weight of exactly 0 could be saved with no unit at all.
  it("treats a weight of exactly 0 as started, not absent", () => {
    expect(hasStartedWeight({ weight: 0 })).toBe(true);
  });
});