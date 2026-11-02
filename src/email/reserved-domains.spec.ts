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

import { hasReservedDomain } from './reserved-domains'

describe('hasReservedDomain', () => {
  it.each([
    'pat@stride.test',
    'a@b.c.test',
    'x@thing.example',
    'x@host.invalid',
    'x@localhost',
    'x@app.localhost',
    'someone@example.com',
    'someone@example.net',
    'someone@example.org',
    'someone@mail.example.com',
    // Case and DNS's absolute form don't make another name.
    'Someone@EXAMPLE.COM',
    'pat@stride.test.',
    // The domain is after the LAST "@".
    '"a@gmail.com"@example.com',
  ])('is true for %s', (address) => {
    expect(hasReservedDomain(address)).toBe(true)
  })

  it.each([
    'someone@gmail.com',
    'someone@clinic.org',
    // Look-alikes are real, ownable names.
    'someone@myexample.com',
    'someone@example.co',
    'someone@test.com',
    'someone@stride.testing',
    'someone@examples.org',
  ])('is false for %s', (address) => {
    expect(hasReservedDomain(address)).toBe(false)
  })
})
