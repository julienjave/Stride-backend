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

import { exportFileName } from './records-export.service'

// The service itself reads the database, draws and audits — its behaviour
// is tested end to end (test/records-export.e2e-spec.ts). Its one pure
// helper is tested here.
describe('exportFileName', () => {
  // 23:30 UTC on March 14th: already the 15th in Paris, still the 14th in
  // Montreal — the file is named after the PATIENT's day.
  const madeAt = new Date('2031-03-14T23:30:00Z')

  it('names the file after the day of the copy, in the patient’s zone', () => {
    expect(exportFileName(madeAt, 'Europe/Paris')).toBe(
      'stride-health-record-2031-03-15.pdf',
    )
    expect(exportFileName(madeAt, 'America/Montreal')).toBe(
      'stride-health-record-2031-03-14.pdf',
    )
  })

  it('writes the month and day with two digits', () => {
    expect(exportFileName(new Date('2031-01-05T12:00:00Z'), 'UTC')).toBe(
      'stride-health-record-2031-01-05.pdf',
    )
  })
})
