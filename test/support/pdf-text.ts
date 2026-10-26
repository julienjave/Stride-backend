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

// Reads back the TEXT of a PDF made by pdfkit — for tests, so they can say
// "page 2 shows this" without a PDF library (records export, decisions §20).
//
// Why it's needed: a PDF doesn't store "Hello". With an embedded font, each
// piece of text is a list of GLYPH NUMBERS in that font
// (`[<00010002…> 0] TJ` = "draw glyphs 1, 2…"), and pdfkit numbers the
// glyphs of each font in the order it first used them. What lets a reader
// copy text out of a PDF is a table the font carries, its ToUnicode CMap:
// "glyphs 0 to 9 are H, i, space, Ł…". This helper does what a reader does:
//   1. finds each font's table (`/F2 9 0 R` → object 9 → `/ToUnicode 20 0 R`
//      → object 20);
//   2. walks each page's drawing instructions, remembering the current font
//      (`/F2 10 Tf` = "font F2, 10 points") and turning every TJ's glyph
//      numbers into characters through that font's table.
//
// pdfkit COMPRESSES its streams (drawing instructions, tables, fonts) with
// "FlateDecode" — the zlib format — so each is inflated first, with Node's
// own zlib. Only for pdfkit's output: other producers write their tables
// in forms this doesn't read. Each `TJ` becomes one string — one line of a
// paragraph, or one font's part of a line ("Name: " in bold, then "Pat
// Lee").

// --- IMPORTS -----------------------------------------------------------------------------------------------

import { inflateSync } from 'node:zlib'

// --- READING -----------------------------------------------------------------------------------------------

// One piece of text and where it starts on its page, in points from the
// page's left edge and from its BOTTOM (PDF measures upwards).
export interface PdfPiece {
  text: string
  x: number
  y: number
}

// The text pieces of each page, page by page, in drawing order.
export function pdfPages(pdf: Buffer): string[][] {
  return pdfPieces(pdf).map((page) => page.map((piece) => piece.text))
}

// The same, with each piece's position — for the tests of WHERE text goes
// (a centred footer, an indented list).
export function pdfPieces(pdf: Buffer): PdfPiece[][] {
  return pageContents(pdf).map(({ stream, fonts }) => pageText(stream, fonts))
}

// How many shapes each page FILLS (`f`, pdfkit's fill instruction — text
// is drawn by other ones). In the export, the only ones are the dots of the
// lists.
export function pdfFilledShapes(pdf: Buffer): number[] {
  return pageContents(pdf).map(
    ({ stream }) => stream.match(/^f$/gm)?.length ?? 0,
  )
}

// Each page's drawing instructions, and the glyph tables of the fonts.
function pageContents(
  pdf: Buffer,
): { stream: string; fonts: Map<string, Map<number, string>> }[] {
  // latin1 maps every byte to one character and back: the file's structure
  // is ASCII, and binary font data passes through untouched.
  const file = pdf.toString('latin1')

  const objects = new Map<string, string>()
  for (const match of file.matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g)) {
    objects.set(match[1], inflated(match[2]))
  }
  const object = (id: string): string => {
    const body = objects.get(id)
    if (body === undefined) throw new Error(`No object ${id} in the PDF`)
    return body
  }

  // Font resource name (F2) → its glyph table.
  const fonts = new Map<string, Map<number, string>>()
  for (const match of file.matchAll(/\/(F\d+) (\d+) 0 R/g)) {
    const toUnicode = /\/ToUnicode (\d+) 0 R/.exec(object(match[2]))
    if (toUnicode) fonts.set(match[1], glyphTable(object(toUnicode[1])))
  }

  // The pages in order: the page tree's /Kids, then each page's /Contents.
  const kids = /\/Type \/Pages\n\/Count \d+\n\/Kids \[([^\]]*)\]/.exec(file)
  if (!kids) throw new Error('No page tree in the PDF')
  return [...kids[1].matchAll(/(\d+) 0 R/g)].map((page) => {
    const contents = /\/Contents (\d+) 0 R/.exec(object(page[1]))
    if (!contents) throw new Error(`Page ${page[1]} has no contents`)
    return { stream: object(contents[1]), fonts }
  })
}

// The document's metadata (what a reader shows under "Properties"): the
// Info dictionary names an object per field (`/Title 18 0 R`), each a
// string in parentheses. pdfkit writes ASCII text that way; anything else it
// writes in hex, which this doesn't read (the tests' values are ASCII).
export function pdfInfo(pdf: Buffer): Record<string, string> {
  const file = pdf.toString('latin1')
  const info = /\/Info (\d+) 0 R/.exec(file)
  if (!info) throw new Error('No Info dictionary in the PDF')
  const body = new RegExp(`\\n${info[1]} 0 obj\\n<<([^>]*)>>`).exec(file)
  if (!body) throw new Error(`No object ${info[1]} in the PDF`)
  const fields: Record<string, string> = {}
  for (const field of body[1].matchAll(/\/(\w+) (\d+) 0 R/g)) {
    const value = new RegExp(`\\n${field[2]} 0 obj\\n\\((.*)\\)\\nendobj`).exec(
      file,
    )
    if (value) fields[field[1]] = value[1]
  }
  return fields
}

// Every text piece of the document, pages joined.
export function pdfText(pdf: Buffer): string[] {
  return pdfPages(pdf).flat()
}

// An object whose stream is compressed, with the stream inflated; any other
// object as it is.
function inflated(body: string): string {
  const stream =
    /^([\s\S]*?\/Filter \/FlateDecode[\s\S]*?)stream\n([\s\S]*)\nendstream$/.exec(
      body,
    )
  if (!stream) return body
  const bytes = inflateSync(Buffer.from(stream[2], 'latin1'))
  return `${stream[1]}stream\n${bytes.toString('latin1')}\nendstream`
}

// Each piece starts where the last `Tm` before it put the cursor:
// `1 0 0 1 72 698.62 Tm` = "x 72, y 698.62" (pdfkit writes no other kind).
function pageText(
  stream: string,
  fonts: Map<string, Map<number, string>>,
): PdfPiece[] {
  const pieces: PdfPiece[] = []
  let font: Map<number, string> | undefined
  let x = 0
  let y = 0
  for (const match of stream.matchAll(
    /1 0 0 1 ([\d.-]+) ([\d.-]+) Tm|\/(F\d+) [\d.]+ Tf|\[(.*?)\] TJ/g,
  )) {
    if (match[1] !== undefined) {
      x = Number(match[1])
      y = Number(match[2])
      continue
    }
    if (match[3] !== undefined) {
      font = fonts.get(match[3])
      continue
    }
    if (!font) throw new Error('Text drawn before any font was chosen')
    let piece = ''
    for (const hex of match[4].matchAll(/<([0-9a-f]+)>/g)) {
      for (let at = 0; at < hex[1].length; at += 4) {
        piece += font.get(parseInt(hex[1].slice(at, at + 4), 16)) ?? '�'
      }
    }
    pieces.push({ text: piece, x, y })
  }
  return pieces
}

// pdfkit's ToUnicode CMap: one or more `<first> <last> [<u1> <u2> …]`
// ranges — glyph `first` is u1, the next u2, and so on. Each `<u…>` is
// UTF-16 (a letter outside the first 65,536 is two 4-digit halves), and may
// hold SEVERAL characters, space-separated: a ligature is one glyph drawn
// for two letters ("fi" in "file" is `<0066 0069>`). Missing those would
// shift every later glyph by one.
function glyphTable(cmap: string): Map<number, string> {
  const table = new Map<number, string>()
  for (const range of cmap.matchAll(
    /<([0-9a-f]+)> <[0-9a-f]+> \[([^\]]*)\]/g,
  )) {
    let glyph = parseInt(range[1], 16)
    for (const unicode of range[2].matchAll(/<([0-9a-f ]+)>/g)) {
      const digits = unicode[1].replaceAll(' ', '')
      const units: number[] = []
      for (let at = 0; at < digits.length; at += 4) {
        units.push(parseInt(digits.slice(at, at + 4), 16))
      }
      table.set(glyph++, String.fromCharCode(...units))
    }
  }
  return table
}
