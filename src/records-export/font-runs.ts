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

// FONT FALLBACK for the records export (decisions §20): which font draws
// which part of a piece of text.
//
// A browser does this by itself — when the page's font has no glyph for a
// character, it borrows one from another font. pdfkit doesn't: each call
// draws its whole text in ONE font, and a character that font lacks prints
// as an empty box ("tofu"). Noto Sans has no emoji, so a patient's "😊" in
// their feedback would become a box in their copy. This module splits a
// text into RUNS, each drawn in the first font (of a list) that has every
// glyph it needs; the renderer then draws the runs one after another on the
// same line.

// --- IMPORTS -----------------------------------------------------------------------------------------------

import type { Font } from 'fontkit'

// --- TYPES -------------------------------------------------------------------------------------------------

// A font the renderer registered (its name in pdfkit), and the same font
// opened by fontkit — which can answer "do you have a glyph for this?".
export interface CandidateFont {
  name: string
  font: Font
}

export interface FontRun {
  font: string
  text: string
}

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// What a reader sees as ONE character: "👨‍👩‍👧" is five code points, "é"
// may be two (e + a combining accent). Splitting between them would draw
// half a character in one font and half in another. Intl.Segmenter (built
// into Node) knows Unicode's rules for these "grapheme clusters".
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' })

// --- SPLITTING ---------------------------------------------------------------------------------------------

// The text as runs, in order: each character drawn by the FIRST candidate
// that has a glyph for every code point in it (the invisible ones aside),
// neighbours with the same font joined into one run. A character NO
// candidate has is left to the first one — it prints as a box, as it would
// without this: nothing is dropped from a copy that must be complete. An
// empty text has no runs.
export function splitIntoRuns(
  text: string,
  candidates: readonly CandidateFont[],
): FontRun[] {
  const runs: FontRun[] = []
  for (const { segment } of graphemes.segment(text)) {
    const font = (
      candidates.find((candidate) => hasGlyphsFor(candidate.font, segment)) ??
      candidates[0]
    ).name
    const last = runs.at(-1)
    if (last?.font === font) last.text += segment
    else runs.push({ font, text: segment })
  }
  return runs
}

// EVERY code point, the invisible ones included: the zero-width joiner
// that glues 👨‍👩‍👧, the variation selector U+FE0F that asks for the
// emoji style of "©️", the tag letters inside a flag like Scotland's. Fonts
// built for them carry zero-width glyphs for them — Noto Emoji does, Noto
// Sans has the joiner only — so asking for all of them sends "©️" to the
// emoji font, as U+FE0F asks, and leaves a plain "©" in the text.
function hasGlyphsFor(font: Font, character: string): boolean {
  // `for…of` on a string walks CODE POINTS (an emoji is one, though
  // JavaScript stores it as two UTF-16 units).
  for (const symbol of character) {
    if (!font.hasGlyphForCodePoint(symbol.codePointAt(0) ?? 0)) return false
  }
  return true
}
