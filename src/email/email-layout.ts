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

// The one layout every Stride email is drawn in (branded emails, decisions
// §41): the logo, a white card holding the message, its main link as a teal
// button, a one-line footer — light by default, dark where the email app
// asks for it.
//
// WHY IT LOOKS LIKE 1999. HTML in email is not HTML in a browser. Gmail
// rewrites the markup and drops what it doesn't support; desktop Outlook
// renders with Microsoft WORD's engine (no flexbox, no grid, barely any
// `max-width` or `margin`); many apps strip <link> and <script> entirely.
// What every one of them still draws the same way is the oldest web layout
// there is: nested <table>s with `role="presentation"`, and styles written
// INLINE on each element (`style="…"`) — a <style> block may be dropped, an
// inline style almost never is. So:
//   - the structure is tables, centred with `align="center"` (Word ignores
//     `margin: auto`);
//   - every colour, size and spacing is inline, in the LIGHT theme;
//   - the <style> block holds only what CAN'T be inline — the dark theme, a
//     media query — and is an enhancement: an app that drops it shows the
//     light design, which is complete on its own.
//
// Everything a person typed reaches this file as SafeHtml (safe-html.ts):
// the layout can wrap the caller's paragraphs without re-checking them.

// --- IMPORTS -----------------------------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DARK_EMAIL_COLORS as DARK,
  LIGHT_EMAIL_COLORS as LIGHT,
} from './email-palette'
import type { InlineImage } from './email-transport'
import { markup, type SafeHtml } from './safe-html'

// --- TYPES -------------------------------------------------------------------------------------------------

// The email's main link, drawn as a button: the one thing the email is FOR
// (choose a password, confirm an address, download the record). Plain
// strings: markup`` escapes them.
export interface EmailAction {
  label: string
  url: string
}

export interface EmailContent {
  // The <title> — some apps show it in a preview or a tab; the subject.
  title: string
  // The paragraphs above the button (or all of them, with no button).
  intro: readonly SafeHtml[]
  action?: EmailAction
  // The paragraphs below the button: what the link does next, what to do
  // if this wasn't you.
  outro?: readonly SafeHtml[]
}

// What renderEmail() hands back to EmailService: the HTML body and the
// images it refers to, which must travel in the SAME email (OutgoingEmail's
// inlineImages) or the logo is a broken image.
export interface RenderedEmail {
  html: string
  inlineImages: readonly InlineImage[]
}

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// The fonts every phone and computer already has. Email apps load no web
// fonts (Gmail ignores @font-face entirely), so Geist and Comfortaa can't
// come along — the logo is a picture for exactly that reason. No quotes
// around "Segoe UI": an unquoted family name of several words is valid CSS,
// and it keeps quote characters out of the style attribute.
const FONT =
  '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif'

// The two lockups as PNGs, made from the frontend's stride-light.svg /
// stride-dark.svg at 2× (195 × 80 px), shown at 98 × 40 px: a phone's
// high-density screen draws two pixels per CSS pixel, so a 1× image looks
// soft there. PNG, not SVG — Gmail and Outlook show no SVG at all.
const LOGO_WIDTH = 98
const LOGO_HEIGHT = 40

export const LOGO_LIGHT_CID = 'stride-logo-light'
export const LOGO_DARK_CID = 'stride-logo-dark'

// `__dirname` is this file's folder: src/email under the tests, dist/email
// once built — nest-cli.json's `assets` copies the images there, as it
// does the records PDF's fonts.
const IMAGES_DIR = join(__dirname, 'images')

// Read once, on the first email, then kept: two 6 kB files, the same for
// every email, so there's no reason to read the disk again each time. Lazy
// (not at import) so merely importing this module — a spec, the app's boot —
// touches no file.
let logoImages: readonly InlineImage[] | undefined

// --- FUNCTIONS ---------------------------------------------------------------------------------------------

export function renderEmail(content: EmailContent): RenderedEmail {
  const intro = content.intro.map(paragraph)
  const outro = (content.outro ?? []).map(paragraph)
  const action = content.action ? button(content.action) : markup``

  // The skeleton. Read top to bottom:
  //   - the two <meta>s tell apps that support it that this email has BOTH
  //     themes, so they mustn't invert its colours themselves (Apple Mail,
  //     Outlook.com honour this);
  //   - the <style>'s only job is the dark theme: each `.s-…` class names a
  //     part whose colour changes, and `!important` beats the inline style
  //     (normally the stronger one);
  //   - the dark logo starts HIDDEN, three ways at once, because each app
  //     honours a different one: `display: none`, a zero `max-height` with
  //     `overflow: hidden` (some apps drop display:none from inline styles),
  //     and the `<!--[if !mso]>` comment, which removes it altogether for
  //     desktop Outlook (Word ignores all of the above). Dark mode reveals
  //     it and hides the light one.
  const page = markup`<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${content.title}</title>
<style>
@media (prefers-color-scheme: dark) {
  .s-page { background-color: ${DARK.page} !important; }
  .s-card { background-color: ${DARK.card} !important; border-color: ${DARK.border} !important; }
  .s-text { color: ${DARK.text} !important; }
  .s-link { color: ${DARK.primary} !important; }
  .s-button { background-color: ${DARK.primary} !important; }
  .s-button-label { color: ${DARK.onPrimary} !important; }
  .s-muted { color: ${DARK.muted} !important; }
  .s-logo-light { display: none !important; }
  .s-logo-dark { display: block !important; max-height: none !important; overflow: visible !important; }
}
</style>
</head>
<body class="s-page" style="margin: 0; padding: 0; background-color: ${LIGHT.page};">
<table role="presentation" class="s-page" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: ${LIGHT.page};">
<tr><td align="center" style="padding: 24px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 560px;">
<tr><td style="padding: 0 0 16px 4px;">
<img class="s-logo-light" src="cid:${LOGO_LIGHT_CID}" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" alt="Stride" style="display: block; border: 0;">
<!--[if !mso]><!--><div class="s-logo-dark" style="display: none; max-height: 0; overflow: hidden;"><img src="cid:${LOGO_DARK_CID}" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" alt="Stride" style="display: block; border: 0;"></div><!--<![endif]-->
</td></tr>
<tr><td class="s-card" style="background-color: ${LIGHT.card}; border: 1px solid ${LIGHT.border}; border-radius: 8px; padding: 24px;">
${intro}${action}${outro}</td></tr>
<tr><td style="padding: 16px 4px 0 4px;">
<p class="s-muted" style="margin: 0; font-family: ${FONT}; font-size: 13px; line-height: 20px; color: ${LIGHT.muted};">This is an automatic email about your Stride account.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`
  return { html: page.toString(), inlineImages: loadLogoImages() }
}

// A link inside a sentence ("…reset your password straight away"): teal and
// underlined. Underlined because colour alone mustn't be what marks a link
// (WCAG 1.4.1) — and some apps repaint link colours their own way, so the
// underline is the part that survives.
export function link(url: string, label: string): SafeHtml {
  return markup`<a class="s-link" href="${url}" style="color: ${LIGHT.primary}; text-decoration: underline;">${label}</a>`
}

// --- HELPERS -----------------------------------------------------------------------------------------------

// Each paragraph gets its full style inline: an app that drops the <style>
// block, or one that resets <p> margins, still shows the same spacing.
function paragraph(content: SafeHtml): SafeHtml {
  return markup`<p class="s-text" style="margin: 0 0 16px 0; font-family: ${FONT}; font-size: 16px; line-height: 24px; color: ${LIGHT.text};">${content}</p>
`
}

// The "bulletproof button": a one-cell table with the teal fill, and the
// link inside it padded to the cell's size. A CSS button (padding and a
// background on the <a> alone) collapses to a bare link in desktop Outlook;
// the table cell keeps its fill there, and the padded <a> makes the WHOLE
// shape clickable everywhere else. 12 px + 24 px line + 12 px = 48 px high —
// above the 44 px minimum touch target, for phones.
function button(action: EmailAction): SafeHtml {
  return markup`<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 8px 0 24px 0;">
<tr><td class="s-button" style="border-radius: 6px; background-color: ${LIGHT.primary};">
<a class="s-button-label" href="${action.url}" style="display: inline-block; padding: 12px 20px; font-family: ${FONT}; font-size: 16px; line-height: 24px; font-weight: 600; color: ${LIGHT.onPrimary}; text-decoration: none; border-radius: 6px;">${action.label}</a>
</td></tr>
</table>
`
}

function loadLogoImages(): readonly InlineImage[] {
  logoImages ??= [
    logoImage(LOGO_LIGHT_CID, 'stride-light.png'),
    logoImage(LOGO_DARK_CID, 'stride-dark.png'),
  ]
  return logoImages
}

function logoImage(contentId: string, file: string): InlineImage {
  return {
    contentId,
    // The same name for both: if an app lists the parts after all, "Stride"
    // twice reads better than two file names.
    filename: 'stride.png',
    contentType: 'image/png',
    content: readFileSync(join(IMAGES_DIR, file)),
  }
}
