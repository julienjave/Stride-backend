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

// Range of motion's rules and words (Phase 7, 2026-10-31), written once for
// the DTO, the service and the tests — the shape of medical-file-rules.ts.
// The database holds the same rules as constraints, policies and triggers
// (migrations 0076 / 0077); the e2e suite checks the two agree.

// --- IMPORTS -----------------------------------------------------------------------------------------------

import { amendmentReasonMessages } from '../common/validators/amendment-reason'
import {
  ROM_NOTE_MAX_LENGTH,
  ROM_MEASUREMENTS_MAX,
} from '../database/schema/range-of-motion.schema'
import {
  LOWEST_DEGREES,
  ROM_JOINTS,
  ROM_JOINT_LABELS,
  ROM_MOVEMENTS,
  ROM_MOVEMENT_DETAILS,
  ROM_SIDES,
  highestDegrees,
  type RomJoint,
  type RomMovement,
} from './movement-catalogue'

// --- ONE MEASUREMENT ---------------------------------------------------------------------------------------

// A movement measured on a side needs one; a movement with none (neck and
// trunk flexion / extension) must not have one. Checked per measurement by
// the DTO — which knows WHICH measurement and can name it — and by the CHECK
// rom_measurements_side_matches_movement.
export const sideNeededMessage = (movement: RomMovement) =>
  `${ROM_MOVEMENT_DETAILS[movement].name} needs a side: left or right`
export const noSideMessage = (movement: RomMovement) =>
  `${ROM_MOVEMENT_DETAILS[movement].name} has no side`
export const SIDE_VALUE_MESSAGE = `side must be one of: ${ROM_SIDES.join(', ')}`

// Degrees outside the movement's plausible bounds (a typing mistake — the
// catalogue's highestDegrees). The CHECK rom_measurements_degrees_plausible
// holds the same bounds.
export const degreesOutOfRangeMessage = (movement: RomMovement) =>
  `${ROM_MOVEMENT_DETAILS[movement].name} must be between ${LOWEST_DEGREES}° and ${highestDegrees(movement)}°`

export const BLANK_NOTE_MESSAGE = "A measurement's note can't be blank"
export const NOTE_TOO_LONG_MESSAGE = `A measurement's note can be at most ${ROM_NOTE_MAX_LENGTH} characters`

// --- THE ASSESSMENT ----------------------------------------------------------------------------------------

export const NO_MEASUREMENT_MESSAGE =
  'An assessment needs at least one measurement'
export const TOO_MANY_MEASUREMENTS_MESSAGE = `An assessment can hold at most ${ROM_MEASUREMENTS_MAX} measurements`
// Two values for the same movement, side and mode in one assessment — the
// unique index rom_measurements_one_value_per_kind is the only judge (a rule
// across the list's items; one layer, one answer).
export const DUPLICATE_MEASUREMENT_MESSAGE =
  'Each movement can be measured once per side and mode in an assessment'
// measuredOn after the day it was recorded — the CHECK
// rom_assessments_measured_by_recording, the only judge: the database's clock
// is the one that counts, and only it knows the moment of the insert.
export const FUTURE_DATE_MESSAGE = "The measurement date can't be in the future"

export const ROM_AMENDMENT_REASON_MESSAGES =
  amendmentReasonMessages('an assessment')

// --- WHO, AND WHICH RECORD ---------------------------------------------------------------------------------

// The INSERT policy's refusal (42501): the role guard let a practitioner
// through and created_by is the caller, so the one reason left is the care
// team.
export const NOT_ON_CARE_TEAM_WRITE_MESSAGE =
  'You can only record range of motion for a patient on your care team'
export const NOT_ON_CARE_TEAM_READ_MESSAGE =
  "You do not have permission to view this patient's range of motion"
export const OWN_RECORD_ONLY_MESSAGE =
  'You can only view your own range of motion'
export const PATIENT_ID_REQUIRED_MESSAGE = 'patientId is required'
// amendsId names no assessment of THIS patient (the composite foreign key, or
// the not-self CHECK for the new row's own id).
export const AMENDS_UNKNOWN_ASSESSMENT_MESSAGE =
  "The assessment to amend isn't in this patient's record"
export const ALREADY_AMENDED_MESSAGE =
  'This assessment has already been amended — amend its latest version instead'
// medicalFileEntryId names no entry of THIS patient (the composite foreign
// key rom_assessments_note_same_patient_fk).
export const NOTE_UNKNOWN_MESSAGE =
  "The note to link isn't in this patient's medical file"
export const assessmentNotFoundMessage = (id: number) =>
  `Range-of-motion assessment ${id} not found`

// --- THE CATALOGUE, AS THE API SERVES IT -------------------------------------------------------------------

// GET /range-of-motion/movements: the joints in examination order, each with
// its movements — what the screens need to offer a picker, label a chart and
// draw the typical value, from the one list the database was built from.
export interface MovementCatalogue {
  joints: {
    joint: RomJoint
    label: string
    movements: {
      movement: RomMovement
      label: string
      name: string
      sided: boolean
      typicalDegrees: number
      lowestDegrees: number
      highestDegrees: number
    }[]
  }[]
}

export function movementCatalogue(): MovementCatalogue {
  return {
    joints: ROM_JOINTS.map((joint) => ({
      joint,
      label: ROM_JOINT_LABELS[joint],
      movements: ROM_MOVEMENTS.filter(
        (movement) => ROM_MOVEMENT_DETAILS[movement].joint === joint,
      ).map((movement) => {
        const { label, name, sided, typicalDegrees } =
          ROM_MOVEMENT_DETAILS[movement]
        return {
          movement,
          label,
          name,
          sided,
          typicalDegrees,
          lowestDegrees: LOWEST_DEGREES,
          highestDegrees: highestDegrees(movement),
        }
      }),
    })),
  }
}
