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

// The records export's LOOK (decisions §20): a RecordDocument
// (record-content.ts) drawn as a PDF with pdfkit. Every word was chosen
// before this file runs; here only sizes, fonts, spacing and page breaks are
// decided.
//
// How pdfkit works, in short: a PDFDocument is a stream. Each call
// (`text`, `addPage`…) appends drawing instructions at a CURSOR (doc.x,
// doc.y); `text` wraps lines to the page width and starts a new page by
// itself when the cursor reaches the bottom margin. `end()` finishes the
// file, and the bytes come out as 'data' events.

// --- IMPORTS -----------------------------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { create, type Font } from 'fontkit'
import PDFDocument from 'pdfkit'
import type { RecordBlock, RecordDocument } from './record-content'
import { splitIntoRuns, type FontRun } from './font-runs'

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// The fonts, bundled with the code (SIL Open Font License — fonts/OFL.txt
// and fonts/OFL-NotoEmoji.txt):
//   - Noto Sans, regular and bold, for the text. pdfkit's built-in fonts
//     only know Western European letters — a name like "Łukasz" or "Ioánna"
//     would print as wrong characters; Noto Sans covers Latin, Greek and
//     Cyrillic;
//   - Noto Emoji, the black-and-white one, as a FALLBACK (font-runs.ts): the
//     emoji a patient types in their feedback. pdfkit can't draw colour
//     emoji fonts, so they print as outlines — and a skin tone as the plain
//     emoji.
// pdfkit embeds only the glyphs used (a "subset"), so the PDF stays small.
// `__dirname` is this file's folder: src/ under the tests, dist/ once built
// (nest-cli.json copies the fonts there).
const FONTS_DIR = join(__dirname, 'fonts')
const FONT_FILES = {
  body: 'NotoSans-Regular.ttf',
  bold: 'NotoSans-Bold.ttf',
  emoji: 'NotoEmoji-Regular.ttf',
} as const
type FontName = keyof typeof FONT_FILES
const BODY: FontName = 'body'
const BOLD: FontName = 'bold'

// US Letter, with one-inch margins (72 points = 1 inch): what a printer in
// Canada or the US expects.
const PAGE_MARGIN = 72
const FOOTER_SIZE = 8

const SIZES = {
  title: 20,
  heading: { 1: 15, 2: 12.5, 3: 11, 4: 10 },
  body: 10,
} as const

const INK = '#111111'
const MUTED = '#555555'

// A heading needs room for itself AND what usually follows it: one alone
// at the foot of a page, its content on the next, reads as a mistake. In
// points (about 14 per line of body text): a note's heading keeps its
// author, date and first section with it; a session's, its outcome and
// scores; a workout's, the start of its list.
const KEEP_WITH_NEXT = { 2: 120, 3: 60, 4: 100 } as const

// A list item: a dot, then the text indented after it.
const BULLET_RADIUS = 1.5
const LIST_INDENT = 12

// --- RENDERING ---------------------------------------------------------------------------------------------

// The whole PDF, in memory. Why not stream it to the response as it's drawn?
// The export writes its audit entry AFTER the document is made and BEFORE a
// byte leaves (records-export.service.ts): a document that failed half-way
// must not count as handed out, and nothing may leave without its trace. A
// record is a few hundred kilobytes at most, so holding it is cheap.
export function renderRecordPdf(document: RecordDocument): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: PAGE_MARGIN,
      // Keep every page open until the end, so the footers — which need the
      // page COUNT ("page 2 of 5") — can be written once it is known.
      bufferPages: true,
      // The file's own metadata (a reader's "Properties"), and the language
      // a screen reader should speak it in.
      info: { Title: document.title, Author: 'Stride', Creator: 'Stride' },
      lang: 'en-US',
      displayTitle: true,
    })

    // The bytes, collected as pdfkit writes them; 'end' comes once
    // `doc.end()` has finished the file.
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))

    // No try / catch: every call below throws SYNCHRONOUSLY when it fails (a
    // missing font file, say), and a Promise turns a throw inside this
    // function into a rejection by itself.
    const fonts = loadFonts()
    for (const name of Object.keys(fonts) as FontName[]) {
      doc.registerFont(name, fonts[name].data)
    }
    const runsOf = fontRunner(fonts)
    const write = textWriter(doc, runsOf)

    doc.fontSize(SIZES.title).fillColor(INK)
    write(document.title, BOLD)
    doc.moveDown(0.6)
    for (const block of document.blocks) drawBlock(doc, write, block)
    drawFooters(doc, runsOf, document.footer, document.stamp)
    doc.end()
  })
}

// --- FONTS -------------------------------------------------------------------------------------------------

interface LoadedFont {
  // The file's bytes: pdfkit embeds them...
  data: Buffer
  // ...and fontkit (the library pdfkit itself reads fonts with) answers
  // "has this font a glyph for…?" from the same bytes.
  font: Font
}

// Each font read ONCE per document, into memory, for both uses. Exported
// for the font-runs tests, which need real fonts to ask.
export function loadFonts(): Record<FontName, LoadedFont> {
  const load = (file: string): LoadedFont => {
    const data = readFileSync(join(FONTS_DIR, file))
    const font = create(data)
    // A .ttc file holds several fonts and opens as a "collection"; ours are
    // single fonts, which have the method this needs.
    if (!('hasGlyphForCodePoint' in font)) {
      throw new Error(`${file} is a font collection, not one font`)
    }
    return { data, font }
  }
  return {
    body: load(FONT_FILES.body),
    bold: load(FONT_FILES.bold),
    emoji: load(FONT_FILES.emoji),
  }
}

// A text's runs (font-runs.ts) when it's meant for one of our fonts: that
// font first, the emoji font as its fallback.
type RunsOf = (text: string, font: FontName) => FontRun[]

function fontRunner(fonts: Record<FontName, LoadedFont>): RunsOf {
  return (text, font) =>
    splitIntoRuns(text, [
      { name: font, font: fonts[font].font },
      { name: 'emoji', font: fonts.emoji.font },
    ])
}

// What every piece of text goes through: `write(text, font, options)` draws
// it in that font, with the emoji font filling in — its runs one after
// another (`continued: true`), so they share a line and wrap as one text.
// The caller's own `continued` (a label whose value follows) is passed on;
// labels are one line, so it only ever reaches a last line.
//
// Line by line: pdfkit loses its place when a run that `continues` holds a
// line break (the next run was drawn back at the start of the PREVIOUS
// line). So each line is its own chain of runs.
//
// An EMPTY line is written as one space: pdfkit's `text('')` doesn't move
// the cursor, nor end a line a label left open ("Reason: " + an empty value
// would have the next row run on). A space is an ordinary character — its
// line ends and the cursor steps down, as for any line.
type TextWriter = (
  text: string,
  font: FontName,
  options?: PDFKit.Mixins.TextOptions,
) => void

function textWriter(doc: PDFKit.PDFDocument, runsOf: RunsOf): TextWriter {
  return (text, font, options = {}) => {
    const lines = text.split('\n')
    lines.forEach((line) => {
      const runs = runsOf(line === '' ? ' ' : line, font)
      runs.forEach((run, index) => {
        doc.font(run.font).text(run.text, {
          ...options,
          continued: index < runs.length - 1 || options.continued === true,
        })
      })
    })
  }
}

// --- BLOCKS ------------------------------------------------------------------------------------------------

function drawBlock(
  doc: PDFKit.PDFDocument,
  write: TextWriter,
  block: RecordBlock,
): void {
  switch (block.kind) {
    case 'heading': {
      const size = SIZES.heading[block.level]
      // A part of the record starts on a new page (one always follows the
      // first page's details, so the cursor is never at the top of an empty
      // page here); a smaller heading only needs room for itself and what
      // follows.
      if (block.level === 1) doc.addPage()
      else keepRoom(doc, KEEP_WITH_NEXT[block.level])
      doc.moveDown(block.level === 1 ? 0 : 0.6)
      doc.fontSize(size).fillColor(INK)
      write(block.text, BOLD)
      doc.moveDown(0.3)
      return
    }
    case 'fields':
      doc.fontSize(SIZES.body).fillColor(INK)
      for (const [label, value] of block.rows) {
        // `continued`: the value goes on the same line as its label, in the
        // regular font, and wraps under it if it's long.
        write(`${label}: `, BOLD, { continued: true })
        write(value, BODY)
      }
      doc.moveDown(0.4)
      return
    case 'text':
      keepRoom(doc, 30)
      doc.fontSize(SIZES.body).fillColor(INK)
      write(block.label, BOLD)
      // As written: the line breaks the author typed stay (Windows' \r\n
      // counted as one).
      write(block.text.replace(/\r\n?/g, '\n'), BODY)
      doc.moveDown(0.5)
      return
    case 'paragraph':
      doc.fontSize(SIZES.body).fillColor(block.muted ? MUTED : INK)
      write(block.text, BODY)
      doc.moveDown(0.4)
      return
    case 'list':
      drawList(doc, write, block.items)
      doc.moveDown(0.5)
      return
  }
}

// A list drawn by hand: pdfkit's own `list()` takes plain strings, each
// drawn in one font — an emoji in an item would be a box. Each item: room
// for its first line (so a dot never sits alone at the foot of a page), a
// dot in the middle of that line, the text from the indent — its wrapped
// lines start there too (`text` keeps the x it started at).
function drawList(
  doc: PDFKit.PDFDocument,
  write: TextWriter,
  items: string[],
): void {
  doc.fontSize(SIZES.body).fillColor(INK)
  const left = doc.page.margins.left
  for (const item of items) {
    keepRoom(doc, doc.currentLineHeight(true))
    doc
      .circle(
        left + BULLET_RADIUS,
        doc.y + doc.currentLineHeight(true) / 2,
        BULLET_RADIUS,
      )
      .fill(INK)
    doc.x = left + LIST_INDENT
    write(item, BODY)
  }
  doc.x = left
}

// A new page when less than `height` points are left above the bottom
// margin.
function keepRoom(doc: PDFKit.PDFDocument, height: number): void {
  const bottom = doc.page.height - doc.page.margins.bottom
  if (doc.y + height > bottom) doc.addPage()
}

// "Health record of Pat Lee · copy made on October 26, 2026 · Page 2 of 5",
// at the foot of every page. Written last, page by page (bufferPages). A
// review copy's stamp (decisions §25, pass 2) goes on the line above, in
// bold: on EVERY page, so no page of a review copy can pass for the
// patient's own.
//
// The footer sits INSIDE the bottom margin, where a flowing `text` would
// start a new page instead. Drawn at an exact position with `lineBreak:
// false`, a text is placed where it's told: no flow, no new page.
//
// Centred BY HAND: pdfkit's `align: 'center'` centres each run on its own,
// so a name with an emoji had its runs drawn over each other. Instead: the
// runs' total width (each measured in its own font), then each run drawn
// from where the centred line starts. One line, never wrapped — a long name
// runs past the margin rather than into the page's edge.
function drawFooters(
  doc: PDFKit.PDFDocument,
  runsOf: RunsOf,
  footer: string,
  stamp: string | undefined,
): void {
  const { start, count } = doc.bufferedPageRange()
  const y = doc.page.height - PAGE_MARGIN / 2
  for (let index = start; index < start + count; index++) {
    doc.switchToPage(index)
    doc.fontSize(FOOTER_SIZE)
    if (stamp !== undefined) {
      doc.fillColor(INK)
      // One footer line's height above it (currentLineHeight at the footer's
      // size), so the two never touch — still well inside the bottom margin.
      drawCentredLine(doc, runsOf(stamp, BOLD), y - doc.currentLineHeight(true))
    }
    doc.fillColor(MUTED)
    drawCentredLine(
      doc,
      runsOf(`${footer} · Page ${index - start + 1} of ${count}`, BODY),
      y,
    )
  }
}

// One line of runs, centred on the page at height `y`, never wrapped.
function drawCentredLine(
  doc: PDFKit.PDFDocument,
  lineRuns: FontRun[],
  y: number,
): void {
  const runs = lineRuns.map((run) => ({
    ...run,
    width: doc.font(run.font).widthOfString(run.text),
  }))
  const total = runs.reduce((sum, run) => sum + run.width, 0)
  let x = (doc.page.width - total) / 2
  for (const run of runs) {
    doc.font(run.font).text(run.text, x, y, { lineBreak: false })
    x += run.width
  }
}
