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

import { splitIntoRuns, type CandidateFont } from './font-runs'
import { loadFonts } from './record-pdf'

// With the REAL fonts the export bundles: what each one covers is the
// question under test.
const fonts = loadFonts()
const body: CandidateFont = { name: 'body', font: fonts.body.font }
const bold: CandidateFont = { name: 'bold', font: fonts.bold.font }
const emoji: CandidateFont = { name: 'emoji', font: fonts.emoji.font }

function runs(text: string, primary: CandidateFont = body) {
  return splitIntoRuns(text, [primary, emoji])
}

describe('splitIntoRuns', () => {
  it('keeps text the first font covers in one run', () => {
    expect(runs('Łukasz Żółć · Ιωάννα · Ольга — 3 × 10')).toStrictEqual([
      { font: 'body', text: 'Łukasz Żółć · Ιωάννα · Ольга — 3 × 10' },
    ])
  })

  it('hands each emoji to the fallback, and joins neighbours', () => {
    expect(runs('Good 😊👍 day 🎉')).toStrictEqual([
      { font: 'body', text: 'Good ' },
      { font: 'emoji', text: '😊👍' },
      { font: 'body', text: ' day ' },
      { font: 'emoji', text: '🎉' },
    ])
  })

  // The primary font is the CALLER's: a bold label stays bold.
  it('falls back from whichever font the text is meant for', () => {
    expect(runs('Plan 💪', bold)).toStrictEqual([
      { font: 'bold', text: 'Plan ' },
      { font: 'emoji', text: '💪' },
    ])
  })

  // One character as a reader sees it, never split between two fonts — even
  // when it's several code points glued by invisible ones.
  it.each([
    ['a family (three emoji joined by ZWJs)', '👨‍👩‍👧'],
    ['a skin tone (an emoji and its modifier)', '👍🏽'],
    ['an emoji-style heart (with variation selector FE0F)', '❤️'],
    ['a flag (two regional indicators)', '🇫🇷'],
    // 🏴 followed by invisible TAG letters spelling "gbsct", then a closing
    // tag: the flag of Scotland. Only the emoji font has (zero-width)
    // glyphs for the tags.
    [
      'a flag spelled with tags',
      '\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}',
    ],
    // U+FE0E asks for the TEXT style; the heart itself is only in the
    // emoji font, so that's where it goes.
    ['a text-style heart (with variation selector FE0E)', '\u2764\ufe0e'],
  ])('keeps %s in one run', (_label, character) => {
    expect(runs(`a${character}b`)).toStrictEqual([
      { font: 'body', text: 'a' },
      { font: 'emoji', text: character },
      { font: 'body', text: 'b' },
    ])
  })

  // "é" typed as e + a combining accent is two code points, one character:
  // Noto Sans has both, so it stays in the text.
  it('keeps a letter with a combining accent with its letter', () => {
    expect(runs('Rene\u0301e 😊')).toStrictEqual([
      { font: 'body', text: 'Rene\u0301e ' },
      { font: 'emoji', text: '😊' },
    ])
  })

  // U+FE0F asks for the emoji style of a symbol the text font also has:
  // only the emoji font has the selector, so the pair goes there. Without
  // it, the text font draws the symbol.
  it('follows a request for the emoji style of a symbol', () => {
    expect(runs('© ©\ufe0f')).toStrictEqual([
      { font: 'body', text: '© ' },
      { font: 'emoji', text: '©\ufe0f' },
    ])
  })

  // Neither font has Chinese letters: left to the first font (a box), never
  // dropped from the copy.
  it('leaves a character no font has to the first one', () => {
    expect(runs('Wang 王 😊')).toStrictEqual([
      { font: 'body', text: 'Wang 王 ' },
      { font: 'emoji', text: '😊' },
    ])
  })

  // The ORDER of the candidates decides: "#" is in both fonts (it starts the
  // keycap emoji #️⃣), and the text font, given first, draws it.
  it('prefers the first candidate that has the character', () => {
    expect(splitIntoRuns('#', [body, emoji])).toStrictEqual([
      { font: 'body', text: '#' },
    ])
    expect(splitIntoRuns('#', [emoji, body])).toStrictEqual([
      { font: 'emoji', text: '#' },
    ])
  })

  it('answers an empty text with no runs', () => {
    expect(runs('')).toStrictEqual([])
  })
})
