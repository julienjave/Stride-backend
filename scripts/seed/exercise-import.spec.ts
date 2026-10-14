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

import { cleanInstructions } from './exercise-import'

describe('cleanInstructions', () => {
  it('drops a blank step and keeps the others in their order', () => {
    expect(
      cleanInstructions(['Stand tall.', '', 'Squat down.', 'Stand up.']),
    ).toEqual(['Stand tall.', 'Squat down.', 'Stand up.'])
  })

  // Every kind of whitespace counts as blank — the DTOs' own rule (\S).
  it('drops steps of spaces, tabs or line breaks', () => {
    expect(cleanInstructions(['One.', '   ', '\t', '\n \n', 'Two.'])).toEqual([
      'One.',
      'Two.',
    ])
  })

  it('trims the steps it keeps', () => {
    expect(cleanInstructions(['  Breathe out.\n'])).toEqual(['Breathe out.'])
  })

  it('leaves clean steps as they are', () => {
    const steps = ['Lie down.', 'Lift the hips.']
    expect(cleanInstructions(steps)).toEqual(steps)
  })
})