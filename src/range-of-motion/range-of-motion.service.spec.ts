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

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common'
import { translateInsertError } from './range-of-motion.service'

// A Postgres error as drizzle throws it: the driver's error in `cause`.
function pgError(code: string, constraint?: string) {
  return Object.assign(new Error('Failed query'), {
    cause: { code, constraint },
  })
}

// The service's routes run against the real database in
// test/range-of-motion.e2e-spec.ts; this pins the translation table — which
// refusal becomes which answer, and that nothing else is swallowed.
describe('translateInsertError', () => {
  it.each([
    [
      'the INSERT policy (42501)',
      pgError('42501'),
      ForbiddenException,
      'You can only record range of motion for a patient on your care team',
    ],
    [
      'a future day (the measured-by-recording CHECK)',
      pgError('23514', 'rom_assessments_measured_by_recording'),
      BadRequestException,
      "The measurement date can't be in the future",
    ],
    [
      "another patient's or a missing assessment (the composite key)",
      pgError('23503', 'rom_assessments_amends_same_patient_fk'),
      BadRequestException,
      "The assessment to amend isn't in this patient's record",
    ],
    [
      'its own id (the not-self CHECK)',
      pgError('23514', 'rom_assessments_not_self_amending'),
      BadRequestException,
      "The assessment to amend isn't in this patient's record",
    ],
    [
      'an assessment amended already (the unique index)',
      pgError('23505', 'rom_assessments_one_amendment_per_assessment'),
      ConflictException,
      'This assessment has already been amended — amend its latest version instead',
    ],
    [
      "another patient's note (the note's composite key)",
      pgError('23503', 'rom_assessments_note_same_patient_fk'),
      BadRequestException,
      "The note to link isn't in this patient's medical file",
    ],
    [
      'the same value twice (the unique index)',
      pgError('23505', 'rom_measurements_one_value_per_kind'),
      BadRequestException,
      'Each movement can be measured once per side and mode in an assessment',
    ],
  ])('turns %s into its answer', (_name, error, type, message) => {
    const translated = translateInsertError(error)
    expect(translated).toBeInstanceOf(type)
    expect((translated as Error).message).toBe(message)
  })

  // The CHECKs the DTO answers first — reaching one is a bug, a loud 500 —
  // and the same SQLSTATEs on other constraints.
  it.each([
    [
      'the side CHECK',
      pgError('23514', 'rom_measurements_side_matches_movement'),
    ],
    [
      'the degrees CHECK',
      pgError('23514', 'rom_measurements_degrees_plausible'),
    ],
    [
      'the "at least one measurement" trigger',
      pgError('23514', 'rom_assessments_has_measurements'),
    ],
    [
      'another foreign key',
      pgError('23503', 'rom_assessments_created_by_users_id_fk'),
    ],
    [
      'another unique constraint',
      pgError('23505', 'rom_assessments_id_patient_unique'),
    ],
    ['a plain error', new Error('connection lost')],
  ])('passes %s on unchanged', (_name, error) => {
    expect(translateInsertError(error)).toBe(error)
  })
})
