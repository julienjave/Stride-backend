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
  datesOverlapPeriod,
  dayInPeriod,
  dayOf,
  disclosureRequestRefusal,
  EXPLANATION_ONLY_WITH_OTHER_MESSAGE,
  EXPLANATION_REQUIRED_MESSAGE,
  HOLD_IN_FUTURE_MESSAGE,
  legalBasisText,
  missingPartsText,
  partFlags,
  partsFromFlags,
  partsText,
  PERIOD_ORDER_MESSAGE,
  periodText,
  RECEIVED_IN_FUTURE_MESSAGE,
  STATEMENT_ONLY_WITH_HOLD_MESSAGE,
  STATEMENT_REQUIRED_MESSAGE,
  type DisclosureRequestDates,
} from './legal-disclosure-rules'

// Far from today (2031), so no test depends on the day it runs.
const TODAY = '2031-03-14'

describe('legal disclosure rules', () => {
  describe('parts', () => {
    it('turns a list into the four columns, and back in the fixed order', () => {
      const flags = partFlags(['messages', 'medical_file'])
      expect(flags).toStrictEqual({
        includesMedicalFile: true,
        includesPrograms: false,
        includesSessions: false,
        includesMessages: true,
      })
      expect(partsFromFlags(flags)).toEqual(['medical_file', 'messages'])
      expect(partsFromFlags(partFlags(['sessions', 'programs']))).toEqual([
        'programs',
        'sessions',
      ])
    })

    it('says one, two, or more parts as a phrase, in the fixed order', () => {
      expect(partsText(['messages'])).toBe('Messages')
      expect(partsText(['messages', 'medical_file'])).toBe(
        'Medical file and messages',
      )
      expect(
        partsText(['sessions', 'programs', 'medical_file', 'messages']),
      ).toBe('Medical file, exercise programs, sessions and messages')
    })

    it('names what was left out, or nothing when all went', () => {
      expect(missingPartsText(['medical_file'])).toBe(
        'exercise programs, sessions and messages',
      )
      expect(missingPartsText(['programs', 'sessions', 'messages'])).toBe(
        'medical file',
      )
      expect(
        missingPartsText(['medical_file', 'programs', 'sessions', 'messages']),
      ).toBeNull()
    })
  })

  describe('the period', () => {
    it('includes both of its ends, and has no limit on an open side', () => {
      const march = { from: '2031-03-01', to: '2031-03-31' }
      expect(dayInPeriod('2031-02-28', march)).toBe(false)
      expect(dayInPeriod('2031-03-01', march)).toBe(true)
      expect(dayInPeriod('2031-03-31', march)).toBe(true)
      expect(dayInPeriod('2031-04-01', march)).toBe(false)
      expect(dayInPeriod('1990-01-01', { from: null, to: '2031-03-31' })).toBe(
        true,
      )
      expect(dayInPeriod('2099-01-01', { from: '2031-03-01', to: null })).toBe(
        true,
      )
      expect(dayInPeriod('2031-02-28', { from: '2031-03-01', to: null })).toBe(
        false,
      )
    })

    it('keeps a program whose dates touch the period at either end', () => {
      const march = { from: '2031-03-01', to: '2031-03-31' }
      // Ends on the first day / starts on the last day: overlaps.
      expect(datesOverlapPeriod('2031-02-01', '2031-03-01', march)).toBe(true)
      expect(datesOverlapPeriod('2031-03-31', null, march)).toBe(true)
      // Ends the day before / starts the day after: doesn't.
      expect(datesOverlapPeriod('2031-02-01', '2031-02-28', march)).toBe(false)
      expect(datesOverlapPeriod('2031-04-01', null, march)).toBe(false)
      // Still running (no end), started before: overlaps.
      expect(datesOverlapPeriod('2030-01-01', null, march)).toBe(true)
      // Open sides.
      expect(
        datesOverlapPeriod('2031-02-01', '2031-02-28', {
          from: null,
          to: '2031-03-31',
        }),
      ).toBe(true)
      expect(
        datesOverlapPeriod('2031-04-01', null, {
          from: '2031-03-01',
          to: null,
        }),
      ).toBe(true)
    })

    it('reads the day of a moment in the zone asked', () => {
      // 02:00 UTC on April 1: still March 31 in Montreal.
      const moment = new Date('2031-04-01T02:00:00Z')
      expect(dayOf(moment, 'America/Montreal')).toBe('2031-03-31')
      expect(dayOf(moment, 'Europe/Paris')).toBe('2031-04-01')
    })

    it('says the period in words, each shape its own way', () => {
      const day = (value: string) => `<${value}>`
      expect(periodText({ from: 'a', to: 'b' }, day)).toBe('<a> to <b>')
      expect(periodText({ from: 'a', to: 'a' }, day)).toBe('<a>')
      expect(periodText({ from: 'a', to: null }, day)).toBe('from <a>')
      expect(periodText({ from: null, to: 'b' }, day)).toBe('up to <b>')
      expect(periodText({ from: null, to: null }, day)).toBe('all dates')
    })
  })

  describe('words', () => {
    it('says a basis, and "other" with its explanation', () => {
      expect(legalBasisText('court_order', null)).toBe('A court order')
      expect(legalBasisText('other', 'A tribunal order')).toBe(
        'Another legal basis: A tribunal order',
      )
      // An explanation is only ever stored with "other" (the CHECK); were it
      // there, a listed basis still says itself.
      expect(legalBasisText('coroner', 'ignored')).toBe(
        'A coroner or medical examiner',
      )
    })
  })

  describe('disclosureRequestRefusal', () => {
    const fine: DisclosureRequestDates = {
      legalBasis: 'court_order',
      basisExplanation: null,
      receivedOn: TODAY,
      periodFrom: null,
      periodTo: null,
      withheldUntil: null,
      withholdingStatement: null,
    }

    it('accepts a request that breaks no rule — today and a one-day period included', () => {
      expect(disclosureRequestRefusal(fine, TODAY)).toBeNull()
      expect(
        disclosureRequestRefusal(
          { ...fine, periodFrom: TODAY, periodTo: TODAY },
          TODAY,
        ),
      ).toBeNull()
      expect(
        disclosureRequestRefusal(
          {
            ...fine,
            legalBasis: 'other',
            basisExplanation: 'Why',
            withheldUntil: '2031-03-15',
            withholdingStatement: 'Asked by the agency',
          },
          TODAY,
        ),
      ).toBeNull()
    })

    it('asks for an explanation with "other", and refuses one without it', () => {
      expect(
        disclosureRequestRefusal({ ...fine, legalBasis: 'other' }, TODAY),
      ).toBe(EXPLANATION_REQUIRED_MESSAGE)
      expect(
        disclosureRequestRefusal({ ...fine, basisExplanation: 'Why' }, TODAY),
      ).toBe(EXPLANATION_ONLY_WITH_OTHER_MESSAGE)
    })

    it('refuses a request received after today', () => {
      expect(
        disclosureRequestRefusal({ ...fine, receivedOn: '2031-03-15' }, TODAY),
      ).toBe(RECEIVED_IN_FUTURE_MESSAGE)
    })

    it('refuses a period that ends before it starts', () => {
      expect(
        disclosureRequestRefusal(
          { ...fine, periodFrom: '2031-03-02', periodTo: '2031-03-01' },
          TODAY,
        ),
      ).toBe(PERIOD_ORDER_MESSAGE)
    })

    it('asks for a statement exactly with a hold', () => {
      expect(
        disclosureRequestRefusal(
          { ...fine, withheldUntil: '2031-04-01' },
          TODAY,
        ),
      ).toBe(STATEMENT_REQUIRED_MESSAGE)
      expect(
        disclosureRequestRefusal(
          { ...fine, withholdingStatement: 'Asked' },
          TODAY,
        ),
      ).toBe(STATEMENT_ONLY_WITH_HOLD_MESSAGE)
    })

    it('refuses a hold that ends today or earlier', () => {
      const held = { ...fine, withholdingStatement: 'Asked' }
      expect(
        disclosureRequestRefusal({ ...held, withheldUntil: TODAY }, TODAY),
      ).toBe(HOLD_IN_FUTURE_MESSAGE)
      expect(
        disclosureRequestRefusal(
          { ...held, withheldUntil: '2031-03-01' },
          TODAY,
        ),
      ).toBe(HOLD_IN_FUTURE_MESSAGE)
    })
  })
})
