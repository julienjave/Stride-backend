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
  LOGO_DARK_CID,
  LOGO_LIGHT_CID,
  link,
  renderEmail,
} from './email-layout'
import { DARK_EMAIL_COLORS, LIGHT_EMAIL_COLORS } from './email-palette'
import { markup } from './safe-html'

// --- HELPERS -----------------------------------------------------------------------------------------------

// The first eight bytes of every PNG file — how a reader knows the format.
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])

// A PNG's size, read from its IHDR chunk: width at bytes 16–19, height at
// 20–23, big-endian.
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

function render(extra: Partial<Parameters<typeof renderEmail>[0]> = {}) {
  return renderEmail({
    title: 'Reset your Stride password',
    intro: [markup`First.`, markup`Second.`],
    ...extra,
  })
}

// --- TESTS -------------------------------------------------------------------------------------------------

describe('renderEmail', () => {
  it('draws each paragraph in its own styled <p>, in order', () => {
    const { html } = render({ outro: [markup`Third.`] })
    const texts = [...html.matchAll(/<p class="s-text"[^>]*>(.*?)<\/p>/g)].map(
      (m) => m[1],
    )
    expect(texts).toEqual(['First.', 'Second.', 'Third.'])
  })

  it('draws the action as a button between the intro and the outro', () => {
    const { html } = render({
      action: { label: 'Reset your password', url: 'https://app.test/r?t=1' },
      outro: [markup`After.`],
    })
    const button = html.indexOf('class="s-button"')
    expect(button).toBeGreaterThan(html.indexOf('Second.'))
    expect(button).toBeLessThan(html.indexOf('After.'))
    expect(html).toMatch(
      /<a class="s-button-label" href="https:\/\/app\.test\/r\?t=1"[^>]*>Reset your password<\/a>/,
    )
  })

  // The button's label and address are plain strings: the layout escapes them.
  it("escapes the button's label and address", () => {
    const { html } = render({
      action: { label: '<b>Go</b>', url: 'https://app.test/?a=1&b=2' },
    })
    expect(html).toContain('href="https://app.test/?a=1&amp;b=2"')
    expect(html).toContain('&lt;b&gt;Go&lt;/b&gt;</a>')
  })

  // An email with nothing to click — "this address already has an account"
  // must hold NO link at all (decisions §12): the skeleton adds none of its
  // own, and no button appears without an action.
  it('adds no link and no button of its own', () => {
    const { html } = render()
    expect(html).not.toContain('href')
    expect(html).not.toContain('class="s-button"')
  })

  it('names the email in its <title>, escaped', () => {
    expect(render({ title: "You're invited" }).html).toContain(
      '<title>You&#39;re invited</title>',
    )
  })

  it('says why the email was sent, in the footer', () => {
    expect(render().html).toMatch(
      /<p class="s-muted"[^>]*>This is an automatic email about your Stride account\.<\/p>/,
    )
  })

  // The light theme is written INLINE — what every app shows, even one that
  // drops the <style> block.
  it('paints the light theme inline', () => {
    const { html } = render({
      action: { label: 'Go', url: 'https://app.test' },
    })
    const L = LIGHT_EMAIL_COLORS
    expect(html).toContain(
      `<body class="s-page" style="margin: 0; padding: 0; background-color: ${L.page};">`,
    )
    expect(html).toContain(
      `background-color: ${L.card}; border: 1px solid ${L.border};`,
    )
    expect(html).toMatch(
      new RegExp(`class="s-text" style="[^"]*color: ${L.text};`),
    )
    expect(html).toMatch(
      new RegExp(
        `class="s-button" style="[^"]*background-color: ${L.primary};`,
      ),
    )
    expect(html).toMatch(
      new RegExp(`class="s-button-label" [^>]*color: ${L.onPrimary};`),
    )
    expect(html).toMatch(
      new RegExp(`class="s-muted" style="[^"]*color: ${L.muted};`),
    )
  })

  // The dark theme lives only in the media query: each class gets its dark
  // colour, strong enough (!important) to beat the inline light one.
  it('repaints every part in the dark theme, inside the media query only', () => {
    const { html } = render()
    const style = /<style>([\s\S]*)<\/style>/.exec(html)?.[1] ?? ''
    expect(
      style.trim().startsWith('@media (prefers-color-scheme: dark) {'),
    ).toBe(true)
    const D = DARK_EMAIL_COLORS
    for (const rule of [
      `.s-page { background-color: ${D.page} !important; }`,
      `.s-card { background-color: ${D.card} !important; border-color: ${D.border} !important; }`,
      `.s-text { color: ${D.text} !important; }`,
      `.s-link { color: ${D.primary} !important; }`,
      `.s-button { background-color: ${D.primary} !important; }`,
      `.s-button-label { color: ${D.onPrimary} !important; }`,
      `.s-muted { color: ${D.muted} !important; }`,
      '.s-logo-light { display: none !important; }',
    ]) {
      expect(style).toContain(rule)
    }
    // …and nothing dark leaks out of the media query into the inline styles.
    const outsideStyle = html.replace(/<style>[\s\S]*<\/style>/, '')
    for (const color of Object.values(D)) {
      expect(outsideStyle).not.toContain(color)
    }
  })

  it('tells apps the email has both themes, so they leave its colours alone', () => {
    const { html } = render()
    expect(html).toContain('<meta name="color-scheme" content="light dark">')
    expect(html).toContain(
      '<meta name="supported-color-schemes" content="light dark">',
    )
  })

  // The logo: the light one shown, the dark one hidden three ways (see the
  // comment in renderEmail) until dark mode reveals it.
  it('shows the light logo and hides the dark one until dark mode', () => {
    const { html } = render()
    expect(html).toMatch(
      new RegExp(
        `<img class="s-logo-light" src="cid:${LOGO_LIGHT_CID}" width="98" height="40" alt="Stride"`,
      ),
    )
    expect(html).toContain(
      `<!--[if !mso]><!--><div class="s-logo-dark" style="display: none; max-height: 0; overflow: hidden;"><img src="cid:${LOGO_DARK_CID}"`,
    )
    expect(html).toContain('</div><!--<![endif]-->')
  })

  it('returns the two logo PNGs the HTML refers to, at twice their shown size', () => {
    const { inlineImages } = render()
    expect(inlineImages.map((i) => i.contentId)).toEqual([
      LOGO_LIGHT_CID,
      LOGO_DARK_CID,
    ])
    for (const image of inlineImages) {
      expect(image.contentType).toBe('image/png')
      expect(image.filename).toBe('stride.png')
      expect(image.content.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
      expect(pngSize(image.content)).toEqual({ width: 195, height: 80 })
    }
    // Two different pictures: the light lockup isn't sent twice.
    expect(inlineImages[0].content.equals(inlineImages[1].content)).toBe(false)
  })

  it('reads the logo files once, then reuses them', () => {
    const first = render().inlineImages
    const second = render().inlineImages
    expect(second[0].content).toBe(first[0].content)
  })
})

describe('link', () => {
  it('draws a teal, underlined link, recoloured in dark mode', () => {
    expect(link('https://app.test/x', 'reset your password').toString()).toBe(
      `<a class="s-link" href="https://app.test/x" style="color: ${LIGHT_EMAIL_COLORS.primary}; text-decoration: underline;">reset your password</a>`,
    )
  })

  it('escapes its address and its words', () => {
    expect(link('https://a.test/?x=1&y=2', '<i>go</i>').toString()).toContain(
      'href="https://a.test/?x=1&amp;y=2"',
    )
    expect(link('https://a.test', '<i>go</i>').toString()).toContain(
      '>&lt;i&gt;go&lt;/i&gt;</a>',
    )
  })
})
