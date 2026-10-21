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

// The decorators record their rules with the Reflect metadata API, which
// Nest loads at startup (main.ts) — a plain test file must load it itself.
import 'reflect-metadata'
import { validate } from 'class-validator'
import { plainToInstance } from 'class-transformer'
import { CreateMedicalFileDto } from './create-medical-file.dto'
import { SOAP_SECTIONS } from '../medical-file-rules'

// CreateMedicalFileDto through the real class-validator engine: every rule
// with its exact message, and what the DTO deliberately leaves to the
// database ("at least one section" — test/medical-files.e2e-spec.ts).

async function errorsFor(plain: object) {
  const errors = await validate(plainToInstance(CreateMedicalFileDto, plain))
  return Object.fromEntries(
    errors.map((error) => [
      error.property,
      Object.values(error.constraints ?? {}),
    ]),
  )
}

const base = { patientId: 20, entryType: 'progress_note' }

describe('CreateMedicalFileDto', () => {
  it('accepts an entry with one section, and with all four', async () => {
    expect(await errorsFor({ ...base, plan: 'Review in 2 weeks' })).toEqual({})
    expect(
      await errorsFor({
        ...base,
        subjective: 'S',
        objective: 'O',
        assessment: 'A',
        plan: 'P',
      }),
    ).toEqual({})
  })

  // Left to the CHECK medical_files_has_content on purpose (one judge for a
  // rule across fields): the DTO lets it through.
  it('lets an entry with no section through — the database decides', async () => {
    expect(await errorsFor(base)).toEqual({})
  })

  it('accepts the three entry types and refuses anything else', async () => {
    for (const entryType of [
      'initial_assessment',
      'progress_note',
      'discharge_summary',
    ]) {
      expect(await errorsFor({ ...base, entryType, plan: 'P' })).toEqual({})
    }
    const message =
      'entryType must be one of the following values: initial_assessment, progress_note, discharge_summary'
    expect(
      await errorsFor({ ...base, entryType: 'progres_note', plan: 'P' }),
    ).toEqual({ entryType: [message] })
    expect(await errorsFor({ patientId: 20, plan: 'P' })).toEqual({
      entryType: [message],
    })
  })

  it('needs an integer patientId', async () => {
    expect(await errorsFor({ ...base, patientId: '20', plan: 'P' })).toEqual({
      patientId: ['patientId must be an integer number'],
    })
  })

  describe.each(SOAP_SECTIONS)('the %s section', (section) => {
    const label = section.charAt(0).toUpperCase() + section.slice(1)

    it('may be absent or null (not written)', async () => {
      // Another section holds the content, so only this one's rule is tried.
      const other = section === 'plan' ? { subjective: 'S' } : { plan: 'P' }
      expect(await errorsFor({ ...base, ...other, [section]: null })).toEqual(
        {},
      )
      expect(
        await errorsFor({ ...base, subjective: 'S', [section]: undefined }),
      ).toEqual({})
    })

    it.each(['', '   ', '\t\n'])('refuses a blank one (%j)', async (text) => {
      expect(await errorsFor({ ...base, [section]: text })).toEqual({
        [section]: [`${label} can't be blank`],
      })
    })

    it('accepts 10,000 characters and refuses 10,001', async () => {
      expect(
        await errorsFor({ ...base, [section]: 'a'.repeat(10_000) }),
      ).toEqual({})
      expect(
        await errorsFor({ ...base, [section]: 'a'.repeat(10_001) }),
      ).toEqual({ [section]: [`${label} can be at most 10000 characters`] })
    })

    it('refuses something that is not text', async () => {
      const errors = await errorsFor({ ...base, [section]: 42 })
      expect(errors[section]).toContain(`${section} must be a string`)
    })
  })

  describe('an amendment', () => {
    const amendment = { ...base, plan: 'P', amendsId: 7 }

    it('is accepted with a reason', async () => {
      expect(
        await errorsFor({ ...amendment, amendmentReason: 'Wrong knee' }),
      ).toEqual({})
    })

    it('needs a reason — missing, null or not text', async () => {
      for (const amendmentReason of [undefined, null, 42]) {
        expect(await errorsFor({ ...amendment, amendmentReason })).toEqual({
          amendmentReason: ['An amendment needs a reason'],
        })
      }
    })

    it.each(['', '  ', '\n'])('refuses a blank reason (%j)', async (reason) => {
      expect(
        await errorsFor({ ...amendment, amendmentReason: reason }),
      ).toEqual({ amendmentReason: ["The amendment reason can't be blank"] })
    })

    it('accepts a 500-character reason and refuses 501', async () => {
      expect(
        await errorsFor({ ...amendment, amendmentReason: 'a'.repeat(500) }),
      ).toEqual({})
      expect(
        await errorsFor({ ...amendment, amendmentReason: 'a'.repeat(501) }),
      ).toEqual({
        amendmentReason: ['The amendment reason can be at most 500 characters'],
      })
    })

    it('refuses a reason without amendsId — absent or null', async () => {
      const message =
        'Only an amendment (an entry with amendsId) has an amendment reason'
      expect(
        await errorsFor({ ...base, plan: 'P', amendmentReason: 'Why' }),
      ).toEqual({ amendmentReason: [message] })
      expect(
        await errorsFor({
          ...base,
          plan: 'P',
          amendsId: null,
          amendmentReason: 'Why',
        }),
      ).toEqual({ amendmentReason: [message] })
    })

    it('needs an integer amendsId', async () => {
      const errors = await errorsFor({
        ...amendment,
        amendsId: 'seven',
        amendmentReason: 'Why',
      })
      expect(errors.amendsId).toEqual(['amendsId must be an integer number'])
    })
  })
})
