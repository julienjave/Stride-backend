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
  DARK_EMAIL_COLORS,
  type EmailColors,
  LIGHT_EMAIL_COLORS,
} from './email-palette'

// --- HELPERS -----------------------------------------------------------------------------------------------

// WCAG 2.x relative luminance of a "#rrggbb" colour: each channel is
// turned from its gamma-encoded 0–255 value back into LINEAR light (the
// piecewise sRGB curve), then weighted by how bright the eye finds it —
// green most, blue least.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// The contrast ratio, 1:1 (identical) to 21:1 (black on white). The 0.05
// stands for the glare of a real screen, so pure black isn't "infinitely"
// dark.
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// Every pair the layout paints as TEXT on a background. 4.5:1 is WCAG AA
// for normal-size text — the emails' 16 px body and 13 px footer are both
// "normal", so no pair gets the 3:1 allowance of large text.
function textPairs(c: EmailColors): [string, string, string][] {
  return [
    ['body text on the card', c.text, c.card],
    ['a link in a sentence, on the card', c.primary, c.card],
    ["the button's label on its fill", c.onPrimary, c.primary],
    ['the footer on the page', c.muted, c.page],
  ]
}

// --- TESTS -------------------------------------------------------------------------------------------------

describe('the email palette', () => {
  describe.each([
    ['light', LIGHT_EMAIL_COLORS],
    ['dark', DARK_EMAIL_COLORS],
  ])('%s', (_theme, colors) => {
    it.each(textPairs(colors))('%s reaches 4.5:1', (_pair, fg, bg) => {
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5)
    })

    // A colour an email app can't parse is dropped silently — so every
    // value must be exactly the form all of them read.
    it('writes every colour as six-digit hex', () => {
      for (const value of Object.values(colors)) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/)
      }
    })
  })

  // The two themes must set the same colours: a key missing from one would
  // leave that part of the email in the OTHER theme's colour.
  it('names the same colours in both themes', () => {
    expect(Object.keys(DARK_EMAIL_COLORS).sort()).toEqual(
      Object.keys(LIGHT_EMAIL_COLORS).sort(),
    )
  })

  // Sanity check of the helper against two textbook values, so a bug in
  // contrast() can't make every assertion above pass.
  it('measures contrast as WCAG does', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
  })
})
