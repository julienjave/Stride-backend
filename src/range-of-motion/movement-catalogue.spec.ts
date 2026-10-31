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
  HIGHEST_DEGREES_CAP,
  ROM_MOVEMENTS,
  ROM_MOVEMENT_DETAILS,
  SIDED_MOVEMENTS,
  highestDegrees,
  measurementLabel,
} from './movement-catalogue'
import { movementCatalogue } from './range-of-motion-rules'

// The catalogue is DATA the database was built from (the enum, the side and
// degrees CHECKs — range-of-motion.schema.ts). These tests pin the few rules
// computed from it; the e2e suite checks the database holds the same.

describe('highestDegrees', () => {
  // Each branch of the rule, with a movement whose typical value lands in it.
  it.each<[string, (typeof ROM_MOVEMENTS)[number], number]>([
    // 0° typical: +20 wins (1.5 × 0 = 0) — 20° of hyperextension.
    ['typical + 20 when larger (knee extension, 0°)', 'knee_extension', 20],
    // 15 × 1.5 = 22.5 → 25, but 15 + 20 = 35 wins.
    [
      'typical + 20 over a small half again (foot eversion, 15°)',
      'ankle_eversion',
      35,
    ],
    // 45 × 1.5 = 67.5 → rounded UP to 70 (a multiple of 5), over 65.
    ['half again, rounded up to 5 (neck flexion, 45°)', 'cervical_flexion', 70],
    // 120 × 1.5 = 180 exactly — not rounded past it.
    [
      'half again, already a multiple of 5 (hip flexion, 120°)',
      'hip_flexion',
      180,
    ],
    // 135 × 1.5 = 202.5 → 205, capped at 200.
    ['never above the cap (knee flexion, 135°)', 'knee_flexion', 200],
  ])('%s', (_label, movement, highest) => {
    expect(highestDegrees(movement)).toBe(highest)
  })

  it('is always above the typical value and never above the cap', () => {
    for (const movement of ROM_MOVEMENTS) {
      expect(highestDegrees(movement)).toBeGreaterThan(
        ROM_MOVEMENT_DETAILS[movement].typicalDegrees,
      )
      expect(highestDegrees(movement)).toBeLessThanOrEqual(HIGHEST_DEGREES_CAP)
    }
  })
})

describe('SIDED_MOVEMENTS', () => {
  // Only neck and trunk flexion / extension are measured without a side.
  it('holds every movement but the four of the spine’s middle line', () => {
    expect(
      ROM_MOVEMENTS.filter((movement) => !SIDED_MOVEMENTS.includes(movement)),
    ).toEqual([
      'cervical_flexion',
      'cervical_extension',
      'thoracolumbar_flexion',
      'thoracolumbar_extension',
    ])
  })
})

describe('measurementLabel', () => {
  it('names the movement, the side when there is one, and the mode', () => {
    expect(measurementLabel('knee_flexion', 'right', 'active')).toBe(
      'Knee flexion, right, active',
    )
    expect(measurementLabel('cervical_flexion', null, 'passive')).toBe(
      'Neck flexion, passive',
    )
  })
})

describe('movementCatalogue', () => {
  // Every movement exactly once, under its own joint, in the tuple's order —
  // the order the database's enum sorts in.
  it('lists every movement once, grouped by joint, in the catalogue’s order', () => {
    const { joints } = movementCatalogue()
    const listed = joints.flatMap((joint) =>
      joint.movements.map((movement) => movement.movement),
    )
    expect(listed).toEqual([...ROM_MOVEMENTS])
    for (const joint of joints) {
      for (const movement of joint.movements) {
        expect(ROM_MOVEMENT_DETAILS[movement.movement].joint).toBe(joint.joint)
      }
    }
  })

  it('gives each movement its words, side, typical value and bounds', () => {
    const neck = movementCatalogue().joints[0]
    expect(neck.label).toBe('Neck')
    expect(neck.movements[3]).toStrictEqual({
      movement: 'cervical_rotation',
      label: 'Rotation',
      name: 'Neck rotation',
      sided: true,
      typicalDegrees: 60,
      lowestDegrees: -90,
      highestDegrees: 90,
    })
  })
})
