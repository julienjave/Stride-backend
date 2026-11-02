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

import PDFDocument from 'pdfkit'
import { loadFonts, renderRecordPdf } from './record-pdf'
import type { RecordBlock, RecordDocument } from './record-content'
import {
  pdfFilledRects,
  pdfFilledShapes,
  pdfImages,
  pdfInfo,
  pdfPages,
  pdfPieces,
  pdfText,
  type PdfPiece,
} from '../../test/support/pdf-text'

// The renderer draws; record-content.spec.ts tests the words. Here: that
// every kind of block reaches the page, in order, in the bundled fonts, with
// a footer on every page and headings kept with what follows them.

function documentOf(blocks: RecordBlock[]): RecordDocument {
  return { title: 'Your health record', footer: 'Health record of Pat', blocks }
}

async function render(blocks: RecordBlock[]): Promise<Buffer> {
  return renderRecordPdf(documentOf(blocks))
}

// Every text piece with its position, pages joined.
async function piecesOf(blocks: RecordBlock[]): Promise<PdfPiece[]> {
  return pdfPieces(await render(blocks)).flat()
}

function paragraph(text: string): RecordBlock {
  return { kind: 'paragraph', text, muted: false }
}

describe('renderRecordPdf', () => {
  it('makes a PDF titled for a reader', async () => {
    const pdf = await renderRecordPdf(documentOf([]))

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pdf.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true)
    // The metadata a reader shows, and its title in the window's bar.
    expect(pdfInfo(pdf)).toMatchObject({
      Title: 'Your health record',
      Author: 'Stride',
      Creator: 'Stride',
    })
    expect(pdf.toString('latin1')).toContain('/DisplayDocTitle true')
    expect(pdf.toString('latin1')).toContain('/Lang (en-US)')
  })

  // Smaller files: the drawing instructions are deflated (pdfText inflates
  // them to read them back).
  it('compresses its content', async () => {
    const pdf = await render([paragraph('Hello')])

    expect(pdf.toString('latin1')).toContain('/Filter /FlateDecode')
    expect(pdf.toString('latin1')).not.toContain('Hello')
  })

  it('draws every kind of block, in order', async () => {
    const pdf = await render([
      { kind: 'heading', level: 2, text: 'Progress note' },
      {
        kind: 'fields',
        rows: [
          ['Written by', 'Alex Chen'],
          ['Written on', 'October 9, 2031'],
        ],
      },
      // Line breaks as typed — Windows' \r\n and an old Mac's \r too.
      { kind: 'text', label: 'Plan', text: 'First line\r\nSecond\rThird' },
      paragraph('A remark.'),
      { kind: 'list', items: ['Bridges — 3 × 10', 'Heel slides'] },
    ])

    expect(pdfText(pdf)).toEqual([
      'Your health record',
      'Progress note',
      'Written by: ',
      'Alex Chen',
      'Written on: ',
      'October 9, 2031',
      'Plan',
      'First line',
      'Second',
      'Third',
      'A remark.',
      'Bridges — 3 × 10',
      'Heel slides',
      'Health record of Pat · Page 1 of 1',
    ])
  })

  // The bundled font: pdfkit's built-in ones only know Western European
  // letters.
  it('writes names in Latin, Greek and Cyrillic letters', async () => {
    const pdf = await render([paragraph('Łukasz Żółć · Ιωάννα · Ольга')])

    expect(pdfText(pdf)).toContain('Łukasz Żółć · Ιωάννα · Ольга')
  })

  it('starts each part of the record on a new page', async () => {
    const pdf = await render([
      paragraph('The first page’s details.'),
      { kind: 'heading', level: 1, text: 'Medical file' },
      paragraph('A note.'),
      { kind: 'heading', level: 1, text: 'Exercise programs and sessions' },
    ])

    expect(pdfPages(pdf)).toEqual([
      [
        'Your health record',
        'The first page’s details.',
        'Health record of Pat · Page 1 of 3',
      ],
      ['Medical file', 'A note.', 'Health record of Pat · Page 2 of 3'],
      ['Exercise programs and sessions', 'Health record of Pat · Page 3 of 3'],
    ])
  })

  // The brand (decisions §42): the logo as a letterhead on the FIRST page
  // only — the others name the patient and the page in their footer.
  it('puts the logo above the title on the first page, and only there', async () => {
    const pdf = await render([
      paragraph('Details.'),
      { kind: 'heading', level: 1, text: 'Medical file' },
    ])

    const images = pdfImages(pdf)
    expect(images.map((page) => page.length)).toEqual([1, 0])
    const [logo] = images[0]
    // At the top-left corner of the text area (one-inch margins), half an
    // inch high, its width following the picture's proportions.
    expect(logo).toMatchObject({ x: 72, y: 72, height: 36 })
    expect(logo.width / logo.height).toBeCloseTo(
      logo.pixelWidth / logo.pixelHeight,
      2,
    )
    // The title starts below it (pieces measure from the page's BOTTOM).
    const title = piece(pdfPieces(pdf)[0], 'Your health record')
    expect(792 - title.y).toBeGreaterThan(logo.y + logo.height)
  })

  // Pixels over the inches it's drawn: what decides whether a printed logo
  // looks sharp. 300 dots per inch is the usual mark for print.
  it('draws a logo sharp enough to print', async () => {
    const [[logo]] = pdfImages(await render([]))

    expect(logo.pixelHeight / (logo.height / 72)).toBeGreaterThanOrEqual(300)
  })

  it('draws the title and every heading in teal, everything else in ink', async () => {
    const pdf = await render([
      { kind: 'fields', rows: [['Name', 'Pat Lee']] },
      { kind: 'heading', level: 1, text: 'Medical file' },
      { kind: 'heading', level: 2, text: 'Progress note' },
      { kind: 'heading', level: 3, text: 'A section' },
      { kind: 'heading', level: 4, text: 'A workout' },
      paragraph('Body text.'),
    ])

    const fills = Object.fromEntries(
      pdfPieces(pdf)
        .flat()
        .map((item) => [item.text, item.fill]),
    )
    const TEAL = '#297573'
    expect(fills).toMatchObject({
      'Your health record': TEAL,
      'Medical file': TEAL,
      'Progress note': TEAL,
      'A section': TEAL,
      'A workout': TEAL,
      'Name: ': '#111111',
      'Pat Lee': '#111111',
      'Body text.': '#111111',
    })
  })

  // Coral is the accent only: a short bar under each PART's heading (the
  // app marks its current section the same way), never a word.
  it("marks each part's heading — and nothing else — with a short coral bar", async () => {
    const pdf = await render([
      paragraph('Details.'),
      { kind: 'heading', level: 1, text: 'Medical file' },
      { kind: 'heading', level: 2, text: 'Progress note' },
      paragraph('A note.'),
      { kind: 'heading', level: 1, text: 'Range of motion' },
    ])

    const rects = pdfFilledRects(pdf)
    expect(rects.map((page) => page.length)).toEqual([0, 1, 1])
    for (const page of [1, 2]) {
      expect(rects[page][0]).toMatchObject({
        x: 72,
        width: 24,
        height: 3,
        fill: '#da7350',
      })
    }
    // Under the heading's line, above what follows (top-down: the bar's y
    // against 792 − a piece's baseline).
    const [bar] = rects[1]
    const pieces = pdfPieces(pdf)[1]
    expect(792 - piece(pieces, 'Medical file').y).toBeLessThan(bar.y)
    expect(792 - piece(pieces, 'Progress note').y).toBeGreaterThan(
      bar.y + bar.height,
    )
  })

  // The bar sits in the space a heading already had below it: drawn on top
  // of that space, it pushed the last line of a full page onto a page of its
  // own (Pat's record went from 8 pages to 9). So a part's first line must
  // start where the code before the bar put it — the heading's line, then
  // `moveDown(0.3)` — within a point.
  it('keeps the space under a part heading as it was, within a point', async () => {
    const pieces = pdfPieces(
      await render([
        paragraph('Details.'),
        { kind: 'heading', level: 1, text: 'Medical file' },
        paragraph('A note.'),
      ]),
    )[1]
    // Baseline to baseline, as drawn now.
    const drawn = piece(pieces, 'Medical file').y - piece(pieces, 'A note.').y

    // As the old code drew it. pdfkit's cursor is a line's TOP; its
    // baseline is the font's ascent below that. So baseline to baseline =
    // the cursor's move (one 15 pt line + 0.3 of one) + the note's ascent −
    // the heading's ascent.
    const fonts = loadFonts()
    const doc = new PDFDocument()
    doc.registerFont('bold', fonts.bold.data)
    const line = doc.font('bold').fontSize(15).currentLineHeight(true)
    const ascent = (font: 'body' | 'bold', size: number) =>
      (fonts[font].font.ascent / fonts[font].font.unitsPerEm) * size
    const before = line * 1.3 + ascent('body', 10) - ascent('bold', 15)

    expect(Math.abs(drawn - before)).toBeLessThan(1)
  })

  // The footers are written last, once the count is known — and inside the
  // bottom margin, which must not push them onto pages of their own.
  it('puts a numbered footer on every page, and only there', async () => {
    const lines = Array.from({ length: 120 }, (_, i) => paragraph(`Line ${i}`))
    const pages = pdfPages(await render(lines))

    expect(pages.length).toBeGreaterThan(2)
    pages.forEach((page, index) => {
      expect(page.at(-1)).toBe(
        `Health record of Pat · Page ${index + 1} of ${pages.length}`,
      )
      expect(page.filter((piece) => piece.includes(' · Page '))).toHaveLength(1)
    })
  })

  // A review copy (decisions §25, pass 2): its stamp on every page, in
  // bold, on the line just above the footer — never in the page's flow.
  it('stamps every page of a review copy above its footer', async () => {
    const lines = Array.from({ length: 120 }, (_, i) => paragraph(`Line ${i}`))
    const STAMP = 'Review copy — made by Avery Admin for complaint review 12'
    const pages = pdfPieces(
      await renderRecordPdf({ ...documentOf(lines), stamp: STAMP }),
    )

    expect(pages.length).toBeGreaterThan(2)
    for (const page of pages) {
      const stamps = page.filter((piece) => piece.text === STAMP)
      const footer = page.find((piece) => piece.text.includes(' · Page '))!
      expect(stamps).toHaveLength(1)
      // PDF coordinates start at the page's BOTTOM-left: a bigger y is
      // higher. Above the footer, close to it, below everything else.
      expect(stamps[0].y).toBeGreaterThan(footer.y)
      expect(stamps[0].y - footer.y).toBeLessThan(15)
      const body = page.filter(
        (piece) => piece !== footer && piece !== stamps[0],
      )
      expect(Math.min(...body.map((piece) => piece.y))).toBeGreaterThan(
        stamps[0].y,
      )
    }
  })

  it('draws no stamp on the patient’s own copy', async () => {
    const pages = pdfPages(await render([paragraph('Line')]))
    expect(pages.flat().some((text) => text.startsWith('Review copy'))).toBe(
      false,
    )
  })

  // Whatever is above it, a heading is on the same page as the block after
  // it: a heading near the foot of a page moves to the next one. Tried at
  // every height a page can be filled to (one more paragraph each time), so
  // some of them leave a heading just enough room for itself and no more.
  it.each([2, 3, 4] as const)(
    'keeps a level-%i heading with what follows it',
    async (level) => {
      for (let filler = 25; filler <= 45; filler++) {
        const pages = pdfPages(
          await render([
            ...Array.from({ length: filler }, (_, i) => paragraph(`Line ${i}`)),
            { kind: 'heading', level, text: 'The heading' },
            { kind: 'fields', rows: [['Outcome', 'Completed']] },
          ]),
        )
        const page = pages.find((texts) => texts.includes('The heading'))
        expect([filler, page?.includes('Outcome: ')]).toEqual([filler, true])
      }
    },
  )

  // --- Emoji: the fallback font (font-runs.ts) ---

  // Each emoji reads back as its own piece: drawn in the emoji font, not
  // as a box in Noto Sans.
  it('draws emoji in every kind of block, and in the title and footer', async () => {
    const pdf = await renderRecordPdf({
      title: 'Your record 📋',
      footer: 'Health record of Zoë 🌟 Lee',
      blocks: [
        { kind: 'heading', level: 2, text: 'Knee 💪' },
        { kind: 'fields', rows: [['Your note', 'Better 😊']] },
        { kind: 'text', label: 'Feedback 🗒', text: 'Great ❤️ day' },
        paragraph('A family 👨‍👩‍👧'),
        { kind: 'list', items: ['Done: Walk 🚶'] },
      ],
    })

    expect(pdfText(pdf)).toEqual([
      'Your record ',
      '📋',
      'Knee ',
      '💪',
      'Your note: ',
      'Better ',
      '😊',
      'Feedback ',
      '🗒',
      'Great ',
      '❤️',
      ' day',
      'A family ',
      '👨‍👩‍👧',
      'Done: Walk ',
      '🚶',
      'Health record of Zoë ',
      '🌟',
      ' Lee · Page 1 of 1',
    ])
  })

  // pdfkit lost its place when a run that continues held a line break: the
  // next line was drawn back on the line before. Line by line, each line
  // starts at the margin, below the last.
  it('starts every line of a mixed text at the margin, below the one before', async () => {
    const pieces = await piecesOf([
      paragraph('First 😊 line\nSecond 🎉 line\nThird'),
    ])
    const at = (text: string) => piece(pieces, text)

    expect(at('Second ').x).toBe(72)
    expect(at('Third').x).toBe(72)
    expect(at('Second ').y).toBeLessThan(at('First ').y)
    expect(at('Third').y).toBeLessThan(at('Second ').y)
    // And the rest of a line stays on it.
    expect(at(' line').y).toBe(at('First ').y)
  })

  // `text('')` alone doesn't move the cursor: a blank line is a step down.
  // Sixty of them fill more than a page.
  it('keeps blank lines', async () => {
    const pages = pdfPages(
      await render([paragraph(`Before${'\n'.repeat(60)}After`)]),
    )

    expect(pages[0]).toContain('Before')
    expect(pages[1]).toContain('After')
  })

  // A label and its value share a line, whatever fonts the value needs.
  it('keeps a label on its value’s line', async () => {
    const pieces = await piecesOf([
      { kind: 'fields', rows: [['Your note', 'Better 😊 today']] },
    ])

    expect(piece(pieces, 'Better ').y).toBe(piece(pieces, 'Your note: ').y)
    expect(piece(pieces, ' today').y).toBe(piece(pieces, 'Your note: ').y)
  })

  // An EMPTY value still ends its label's line: the next row starts below.
  it('ends a label’s line even when its value is empty', async () => {
    const pieces = await piecesOf([
      {
        kind: 'fields',
        rows: [
          ['Reason', ''],
          ['Next', 'Row'],
        ],
      },
    ])

    expect(piece(pieces, 'Next: ').y).toBeLessThan(piece(pieces, 'Reason: ').y)
    expect(piece(pieces, 'Next: ').x).toBe(72)
  })

  // The items after their dot, wrapped lines too; what follows the list is
  // back at the margin.
  it('indents list items, wrapped lines included', async () => {
    const long = `Done: Heel slides — 3 × 10 · “${'Felt fine '.repeat(12)}🙂”`
    const pieces = await piecesOf([
      { kind: 'list', items: [long, 'Done: Bridges'] },
      paragraph('After the list'),
    ])
    // Where each line of the list starts: the leftmost piece of each line
    // between the title and the paragraph after the list.
    const lineStarts = lines(
      pieces.filter(
        (item) =>
          item.y < piece(pieces, 'Your health record').y &&
          item.y > piece(pieces, 'After the list').y,
      ),
    ).map((line) => Math.min(...line.map((item) => item.x)))

    // The long item wraps: three lines in all, each from the indent.
    expect(lineStarts).toEqual([84, 84, 84])
    expect(piece(pieces, 'After the list').x).toBe(72)
  })

  // An item's dot is drawn before its text: without room for the first
  // line, the dot would stay at the foot of a page and the text start the
  // next. Tried at every height, as for the headings.
  it('keeps a list item’s dot on its text’s page', async () => {
    for (let filler = 25; filler <= 45; filler++) {
      const pdf = await render([
        ...Array.from({ length: filler }, (_, i) => paragraph(`Line ${i}`)),
        { kind: 'list', items: ['The item'] },
      ])
      const page = pdfPages(pdf).findIndex((texts) =>
        texts.includes('The item'),
      )
      const dots = pdfFilledShapes(pdf)
      expect([filler, dots[page], dots.reduce((a, b) => a + b, 0)]).toEqual([
        filler,
        1,
        1,
      ])
    }
  })

  // One line, whatever its length: a long name runs past the margin rather
  // than wrapping into the page's edge.
  it('keeps a long footer on one line', async () => {
    const pdf = await renderRecordPdf({
      title: 'T',
      footer: `Health record of ${'Bartholomew-Alexandre '.repeat(4)}😊 Lee`,
      blocks: [],
    })

    expect(lines(pdfPieces(pdf)[0].slice(1))).toHaveLength(1)
  })

  // Centred by hand: the runs side by side on one line, the line's middle
  // at the page's middle (US Letter is 612 points wide). pdfkit's own
  // centring drew the runs over each other.
  it('centres a footer made of several runs', async () => {
    const pdf = await renderRecordPdf({
      title: 'T',
      footer: 'Zoë 🌟 Lee',
      blocks: [],
    })
    const footer = pdfPieces(pdf)[0].slice(1)

    expect(footer.map((item) => item.text)).toEqual([
      'Zoë ',
      '🌟',
      ' Lee · Page 1 of 1',
    ])
    expect(footer[1].x).toBeGreaterThan(footer[0].x)
    expect(footer[2].x).toBeGreaterThan(footer[1].x)
    expect(lines(footer)).toHaveLength(1)
    const last = footer[2]
    const end = last.x + widthIn('body', last.text)
    expect(Math.abs((footer[0].x + end) / 2 - 306)).toBeLessThan(0.5)
  })
})

// Pieces grouped into the lines they sit on, top line first. Within 3
// points counts as one line: pdfkit places emoji-font text about a point
// higher than Noto Sans text (the fonts' heights differ); on the page they
// share a baseline.
function lines(pieces: PdfPiece[]): PdfPiece[][] {
  const result: PdfPiece[][] = []
  for (const item of [...pieces].sort((a, b) => b.y - a.y)) {
    const line = result.at(-1)
    if (line && line[0].y - item.y < 3) line.push(item)
    else result.push([item])
  }
  return result
}

// The piece with exactly this text (there must be one).
function piece(pieces: PdfPiece[], text: string): PdfPiece {
  const found = pieces.find((item) => item.text === text)
  if (!found) throw new Error(`No piece "${text}" in ${JSON.stringify(pieces)}`)
  return found
}

// How wide pdfkit draws a text in one of the export's fonts, at the
// footer's size (8 points) — to find where a centred line ends.
function widthIn(font: 'body', text: string): number {
  const doc = new PDFDocument()
  doc.registerFont(font, loadFonts()[font].data)
  return doc.font(font).fontSize(8).widthOfString(text)
}
