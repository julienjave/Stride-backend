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

// The movements a practitioner can measure (Phase 7, practitioner-measured
// range of motion — the person's choice 2026-10-31: a FIXED list, each with
// its textbook value). Written once, here, and read by:
//   - the database schema (range-of-motion.schema.ts): the movement ENUM and
//     the CHECKs on side and degrees are GENERATED from this list, so the
//     database and the API can't disagree on what exists;
//   - the DTO's messages, the API's GET /range-of-motion/movements (the
//     screens' picker and chart labels), and the records export's words.
//
// Pure data and small pure functions — no imports — so the schema can import
// it without pulling the rest of the app into drizzle-kit.
//
// WHAT A MOVEMENT IS. A joint moves in several directions, each measured on
// its own with a goniometer, in DEGREES from the neutral position
// (anatomical position = 0°). "Knee flexion 95°" = the knee bends 95° from
// straight. So the unit of this catalogue is a joint + a direction.
//
// SIDES. A limb movement is measured on the LEFT or the RIGHT, and the other
// side is the most useful comparison a clinician has (better than any
// textbook value: people differ, their two knees much less). Neck and trunk
// flexion / extension have no side; side bending and rotation do (to the
// left, to the right).
//
// THE TYPICAL VALUE (`typicalDegrees`). The end of the normal range as the
// American Academy of Orthopaedic Surgeons publishes it (The Clinical
// Measurement of Joint Motion, Greene & Heckman, AAOS 1994 — the values
// reproduced in Norkin & White's Measurement of Joint Motion). A GUIDE, not a
// target: published norms differ by source (WikEM gives knee flexion 150°,
// AAOS 135°) and by age, which is why the screens say "typical" and why the
// other side is drawn too. Knee and elbow EXTENSION are 0°: fully straight
// is the norm.
//
// NEGATIVE DEGREES are real data: a knee that can't straighten fully is
// recorded as extension −10° ("10° short of straight"), an ankle that can't
// reach neutral as dorsiflexion −5°. So degrees are a signed whole number.

// --- SIDES AND MODES ---------------------------------------------------------------------------------------

export const ROM_SIDES = ['left', 'right'] as const
export type RomSide = (typeof ROM_SIDES)[number]

// ACTIVE: the patient moves the joint themselves. PASSIVE: the practitioner
// moves it, the patient relaxed. Passive is usually a few degrees more — the
// GAP is itself a finding (weak muscles vs a stiff joint), so the two are
// never mixed on one line.
export const ROM_MODES = ['active', 'passive'] as const
export type RomMode = (typeof ROM_MODES)[number]

// --- JOINTS ------------------------------------------------------------------------------------------------

// In the order a body is examined, top to bottom: the picker's groups.
export const ROM_JOINTS = [
  'cervical_spine',
  'shoulder',
  'elbow',
  'forearm',
  'wrist',
  'thoracolumbar_spine',
  'hip',
  'knee',
  'ankle',
] as const
export type RomJoint = (typeof ROM_JOINTS)[number]

export const ROM_JOINT_LABELS: Record<RomJoint, string> = {
  cervical_spine: 'Neck',
  shoulder: 'Shoulder',
  elbow: 'Elbow',
  forearm: 'Forearm',
  wrist: 'Wrist',
  thoracolumbar_spine: 'Trunk',
  hip: 'Hip',
  knee: 'Knee',
  ankle: 'Ankle and foot',
}

// --- MOVEMENTS ---------------------------------------------------------------------------------------------

// The codes, as a TUPLE of literals: Drizzle's pgEnum needs one (it reads
// the values at compile time to type the column), and the order is the
// enum's — Postgres sorts an enum by its declared order, so ORDER BY movement
// lists them the way the catalogue does. A new movement goes at the END of
// its joint's group here AND in a migration (ALTER TYPE … ADD VALUE … AFTER).
export const ROM_MOVEMENTS = [
  'cervical_flexion',
  'cervical_extension',
  'cervical_lateral_flexion',
  'cervical_rotation',
  'shoulder_flexion',
  'shoulder_extension',
  'shoulder_abduction',
  'shoulder_internal_rotation',
  'shoulder_external_rotation',
  'elbow_flexion',
  'elbow_extension',
  'forearm_pronation',
  'forearm_supination',
  'wrist_flexion',
  'wrist_extension',
  'wrist_radial_deviation',
  'wrist_ulnar_deviation',
  'thoracolumbar_flexion',
  'thoracolumbar_extension',
  'thoracolumbar_lateral_flexion',
  'thoracolumbar_rotation',
  'hip_flexion',
  'hip_extension',
  'hip_abduction',
  'hip_adduction',
  'hip_internal_rotation',
  'hip_external_rotation',
  'knee_flexion',
  'knee_extension',
  'ankle_dorsiflexion',
  'ankle_plantarflexion',
  'ankle_inversion',
  'ankle_eversion',
] as const
export type RomMovement = (typeof ROM_MOVEMENTS)[number]

export interface MovementDetails {
  joint: RomJoint
  // The direction alone, as the picker lists it under its joint ("Flexion").
  label: string
  // The whole name, for a chart's title or a line of the PDF ("Knee
  // flexion").
  name: string
  sided: boolean
  typicalDegrees: number
}

// `satisfies Record<RomMovement, MovementDetails>`: every code above must
// have its details, and no stray key may appear — a movement added to the
// tuple and forgotten here fails to COMPILE (the CLINICAL_AREAS idiom,
// audit-vocabulary.ts).
export const ROM_MOVEMENT_DETAILS = {
  cervical_flexion: m('cervical_spine', 'Flexion', 'Neck flexion', false, 45),
  cervical_extension: m(
    'cervical_spine',
    'Extension',
    'Neck extension',
    false,
    45,
  ),
  cervical_lateral_flexion: m(
    'cervical_spine',
    'Side bending',
    'Neck side bending',
    true,
    45,
  ),
  cervical_rotation: m('cervical_spine', 'Rotation', 'Neck rotation', true, 60),
  shoulder_flexion: m('shoulder', 'Flexion', 'Shoulder flexion', true, 180),
  shoulder_extension: m(
    'shoulder',
    'Extension',
    'Shoulder extension',
    true,
    60,
  ),
  shoulder_abduction: m(
    'shoulder',
    'Abduction',
    'Shoulder abduction',
    true,
    180,
  ),
  shoulder_internal_rotation: m(
    'shoulder',
    'Internal rotation',
    'Shoulder internal rotation',
    true,
    70,
  ),
  shoulder_external_rotation: m(
    'shoulder',
    'External rotation',
    'Shoulder external rotation',
    true,
    90,
  ),
  elbow_flexion: m('elbow', 'Flexion', 'Elbow flexion', true, 150),
  elbow_extension: m('elbow', 'Extension', 'Elbow extension', true, 0),
  forearm_pronation: m('forearm', 'Pronation', 'Forearm pronation', true, 80),
  forearm_supination: m(
    'forearm',
    'Supination',
    'Forearm supination',
    true,
    80,
  ),
  wrist_flexion: m('wrist', 'Flexion', 'Wrist flexion', true, 80),
  wrist_extension: m('wrist', 'Extension', 'Wrist extension', true, 70),
  wrist_radial_deviation: m(
    'wrist',
    'Radial deviation',
    'Wrist radial deviation',
    true,
    20,
  ),
  wrist_ulnar_deviation: m(
    'wrist',
    'Ulnar deviation',
    'Wrist ulnar deviation',
    true,
    30,
  ),
  thoracolumbar_flexion: m(
    'thoracolumbar_spine',
    'Flexion',
    'Trunk flexion',
    false,
    80,
  ),
  thoracolumbar_extension: m(
    'thoracolumbar_spine',
    'Extension',
    'Trunk extension',
    false,
    25,
  ),
  thoracolumbar_lateral_flexion: m(
    'thoracolumbar_spine',
    'Side bending',
    'Trunk side bending',
    true,
    35,
  ),
  thoracolumbar_rotation: m(
    'thoracolumbar_spine',
    'Rotation',
    'Trunk rotation',
    true,
    45,
  ),
  hip_flexion: m('hip', 'Flexion', 'Hip flexion', true, 120),
  hip_extension: m('hip', 'Extension', 'Hip extension', true, 30),
  hip_abduction: m('hip', 'Abduction', 'Hip abduction', true, 45),
  hip_adduction: m('hip', 'Adduction', 'Hip adduction', true, 30),
  hip_internal_rotation: m(
    'hip',
    'Internal rotation',
    'Hip internal rotation',
    true,
    45,
  ),
  hip_external_rotation: m(
    'hip',
    'External rotation',
    'Hip external rotation',
    true,
    45,
  ),
  knee_flexion: m('knee', 'Flexion', 'Knee flexion', true, 135),
  knee_extension: m('knee', 'Extension', 'Knee extension', true, 0),
  ankle_dorsiflexion: m(
    'ankle',
    'Dorsiflexion',
    'Ankle dorsiflexion',
    true,
    20,
  ),
  ankle_plantarflexion: m(
    'ankle',
    'Plantarflexion',
    'Ankle plantarflexion',
    true,
    50,
  ),
  ankle_inversion: m('ankle', 'Inversion', 'Foot inversion', true, 35),
  ankle_eversion: m('ankle', 'Eversion', 'Foot eversion', true, 15),
} as const satisfies Record<RomMovement, MovementDetails>

// A short builder so each line above reads as one row of a table.
function m(
  joint: RomJoint,
  label: string,
  name: string,
  sided: boolean,
  typicalDegrees: number,
): MovementDetails {
  return { joint, label, name, sided, typicalDegrees }
}

// --- PLAUSIBLE DEGREES -------------------------------------------------------------------------------------

// The bounds a recorded value must fall within. NOT clinical limits — they
// catch TYPING mistakes (1350 for 135, an extra or a missing digit) without
// ever refusing a real measurement, so they are deliberately generous:
//   - lowest: −90° for every movement — a joint that can't reach neutral by
//     more than that is not measured this way;
//   - highest: half as much again as the typical value, at least 20° above
//     it (so a typical 0° — knee extension — still allows 20° of
//     hyperextension), rounded up to a multiple of 5, and never above 200°.
// The database's CHECK and the DTO's message are both computed from these.
export const LOWEST_DEGREES = -90
export const HIGHEST_DEGREES_CAP = 200

export function highestDegrees(movement: RomMovement): number {
  const typical = ROM_MOVEMENT_DETAILS[movement].typicalDegrees
  const roomy = Math.max(typical + 20, Math.ceil((typical * 1.5) / 5) * 5)
  return Math.min(HIGHEST_DEGREES_CAP, roomy)
}

// --- LOOKUPS -----------------------------------------------------------------------------------------------

// The movements measured on a side, as a list — what the side CHECK names.
export const SIDED_MOVEMENTS: readonly RomMovement[] = ROM_MOVEMENTS.filter(
  (movement) => ROM_MOVEMENT_DETAILS[movement].sided,
)

// "Knee flexion, right, active" — one measurement's full label, the same
// words in the PDF and the API's messages.
export function measurementLabel(
  movement: RomMovement,
  side: RomSide | null,
  mode: RomMode,
): string {
  const parts: string[] = [ROM_MOVEMENT_DETAILS[movement].name]
  if (side !== null) parts.push(side)
  parts.push(mode)
  return parts.join(', ')
}
