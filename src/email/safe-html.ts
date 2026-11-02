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

// Escaping BY DEFAULT for the emails' HTML (branded emails, decisions §41).
//
// Before the layout, every email was a template string and every value a
// person typed had to be wrapped in escapeHtml() by hand — fourteen emails,
// each one a chance to forget. The layout makes that worse: it takes the
// paragraphs from the caller and wraps each in its own styled <p>, so it
// must be able to TRUST that a paragraph is HTML that was built safely, not a
// string that may hold `<script>` typed into a first-name field.
//
// The answer here is the one React (JSX) and most template engines use:
// interpolated values are TEXT unless proven otherwise, and the proof is a
// type. `markup\`<p>Hello ${firstName}</p>\`` escapes firstName automatically;
// only a value that is ALREADY a SafeHtml (made by this same tag) goes in
// as markup. Forgetting to escape becomes impossible rather than unlikely,
// and the layout's parameters can demand SafeHtml, so a raw string can't
// reach it at all (the compiler refuses).
//
// WHY "markup" AND NOT "html": Prettier treats any template tagged `html` as
// embedded HTML and REFORMATS it — line breaks inside tags, text re-wrapped
// — which changes what the email says (found the first time it ran here).
// A tag of any other name is left exactly as written.

// --- IMPORTS -----------------------------------------------------------------------------------------------

import { escapeHtml } from './escape-html'

// --- TYPES -------------------------------------------------------------------------------------------------

// The key to making a SafeHtml. A Symbol is a value nothing else can
// recreate — `Symbol('x') !== Symbol('x')` — and this one is never
// exported, so only code in THIS file holds it. That is what makes the
// markup tag below the only way to make a SafeHtml.
const SAFE_HTML_KEY = Symbol('SafeHtml')

// A piece of HTML known to be safe: every value in it was escaped, or was
// itself a SafeHtml. A CLASS rather than a branded string type, for one
// reason: `instanceof` is checked at RUNTIME, so markup`` can tell a SafeHtml
// from a plain string while it runs — a brand exists only for the compiler
// and is gone in the JavaScript.
//
// The constructor asks for the key above. Outside this file, `new
// SafeHtml(…)` can't be written: TypeScript wants a value of the key's own
// `unique symbol` type, which nothing else has — and if someone got round
// the compiler (a cast to `any`), the check throws at runtime. So a SafeHtml
// can't be made by accident (or on purpose) from an unescaped string. There
// is deliberately no "trust this string" escape hatch: nothing needs one, and
// each would be a door around the escaping. (A `private` constructor with a
// public static factory would NOT do this: the factory would be that door.)
export class SafeHtml {
  constructor(
    key: typeof SAFE_HTML_KEY,
    readonly value: string,
  ) {
    if (key !== SAFE_HTML_KEY) {
      throw new Error('SafeHtml is made by the markup tag only')
    }
  }

  // So String(safe) gives the HTML rather than "[object Object]" — what
  // renderEmail() returns to EmailService is this string.
  toString(): string {
    return this.value
  }
}

// What may appear inside ${…} in a markup`` template. A number is fine (a
// count of days, a remaining-codes figure): it is escaped like text, which
// changes nothing. Arrays let a template insert a list of SafeHtml pieces
// (the layout's paragraphs) without joining them by hand.
type HtmlValue = string | number | SafeHtml | readonly SafeHtml[]

// --- FUNCTIONS ---------------------------------------------------------------------------------------------

// The tag itself. A "tagged template" is a function JavaScript calls with
// the template's literal parts and its ${} values SEPARATELY — `strings` are
// the fixed pieces the programmer wrote (trusted: they are in the source
// code), `values` are what was interpolated (not trusted). So the tag can
// treat the two differently, which a plain template string can't: by the
// time it exists, the parts are already glued together.
//
// There is always one more string than values: markup`a${x}b${y}c` gets
// strings ['a', 'b', 'c'] and values [x, y].
export function markup(
  strings: TemplateStringsArray,
  ...values: HtmlValue[]
): SafeHtml {
  let out = strings[0]
  values.forEach((value, i) => {
    out += toHtml(value) + strings[i + 1]
  })
  return new SafeHtml(SAFE_HTML_KEY, out)
}

// --- HELPERS -----------------------------------------------------------------------------------------------

function toHtml(value: HtmlValue): string {
  if (value instanceof SafeHtml) return value.value
  // Array.isArray narrows to the array member of the union; each element is
  // a SafeHtml by the type, so it goes in as is.
  if (Array.isArray(value)) return value.map((v: SafeHtml) => v.value).join('')
  return escapeHtml(String(value))
}
