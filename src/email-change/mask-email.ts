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

// --- WHAT THIS FILE IS FOR ---------------------------------------------------------------------------------

// The NEW address as the OLD inbox is shown it, in the two notices sent there
// ("someone asked to change your email to …", "your email was changed to …").
// Masked — the person's choice (decisions §12): the owner recognises their
// own change ("p•••@g•••.com" — yes, my Gmail), while an old or shared inbox
// (a former employer's, a family address) doesn't receive the person's new
// address in full.
//
//   pat.smith@gmail.com        → p•••@g•••.com
//   jo@mail.stride.test        → j•••@m•••.test
//   a@localhost                → a•••@l•••
//
// Kept: the first character of the part before the @, the first character of
// the domain, and the domain's last label (".com", ".test") — enough to
// recognise, not enough to write to. The dots replace the rest whatever its
// length, so the mask doesn't reveal how long the address is either.

// --- MASK --------------------------------------------------------------------------------------------------

export const MASK = '•••'

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  // Never reached with a validated address (@IsEmail()); a value without an
  // @ is masked whole rather than shown.
  if (at <= 0) return `${firstCharacter(email)}${MASK}`

  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  const lastDot = domain.lastIndexOf('.')
  const ending = lastDot > 0 ? domain.slice(lastDot) : ''

  return `${firstCharacter(local)}${MASK}@${firstCharacter(domain)}${MASK}${ending}`
}

// The first CHARACTER, not the first UTF-16 unit: `string[0]` would cut an
// emoji or another character outside the Basic Multilingual Plane in half
// (an address may hold one) and print a broken symbol. Array.from splits by
// code point.
function firstCharacter(text: string): string {
  return Array.from(text)[0] ?? ''
}
