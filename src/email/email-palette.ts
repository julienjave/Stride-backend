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

// Palette A (decisions §39) as the emails can use it (decisions §41).
//
// The app defines its colours as OKLCH tokens in the frontend's index.css.
// Email apps are years behind browsers: Outlook, older Gmail and many
// webmails don't understand oklch() — a colour they can't parse is DROPPED,
// and the text falls back to the app's default (black on white, or worse,
// half of a dark theme). So the emails get the SAME colours written as
// six-digit hex, which every email app has understood since the 1990s.
//
// Converted from index.css on 2026-11-02 (OKLCH → OKLab → linear sRGB →
// sRGB, the same maths as the frontend's src/theme/colorContrast.ts) and
// checked against the pixels the app paints: the primary `#297573` and the
// dark accent `#e88969` match decisions §39's measured values. If index.css
// changes, these must be converted again — a copy across two repositories,
// accepted because the alternative (the backend reading the frontend's CSS)
// would tie the two deployments together for the sake of nine colours.
//
// email-palette.spec.ts checks every text / background pair below against
// WCAG's contrast minimums, as paletteContrast.test.ts does for the app.

// --- CONSTANTS ---------------------------------------------------------------------------------------------

export interface EmailColors {
  // Around the card — index.css `--background`.
  page: string
  // The card holding the message — `--card`.
  card: string
  // The card's 1 px edge — `--border` (dark: 10 % white over the card, the
  // colour that alpha paints, since an email can't rely on rgba borders).
  border: string
  // Body text — `--foreground`.
  text: string
  // The footer — `--muted-foreground`.
  muted: string
  // Links in a sentence and the button's fill — `--primary`.
  primary: string
  // The button's label — `--primary-foreground` (white on the light teal,
  // the dark page colour on the light teal of the dark theme, as in the app).
  onPrimary: string
}

export const LIGHT_EMAIL_COLORS: EmailColors = {
  page: '#fbfaf8',
  card: '#ffffff',
  border: '#e2dfda',
  text: '#181714',
  muted: '#66635d',
  primary: '#297573',
  onPrimary: '#ffffff',
}

export const DARK_EMAIL_COLORS: EmailColors = {
  page: '#101514',
  card: '#181d1c',
  border: '#2f3433',
  text: '#eff3f2',
  muted: '#9da7a5',
  primary: '#5db3ad',
  onPrimary: '#101514',
}

// The coral of the logo (`--brand-accent`) is deliberately absent: an accent
// only (§39), and the emails have no "current section" to mark. It reaches
// the inbox inside the logo image.
