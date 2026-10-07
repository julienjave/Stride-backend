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

import { escapeHtml } from './escape-html'

describe('escapeHtml', () => {
  it('escapes the five characters that mean something in HTML', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    )
  })

  // The chained-replace bug (see the comment in escape-html.ts): each
  // character is replaced once, so an escaped "<" never becomes "&amp;lt;".
  it('never escapes its own output twice', () => {
    expect(escapeHtml('<')).toBe('&lt;')
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })

  it('leaves ordinary text, accents included, untouched', () => {
    expect(escapeHtml('Hélène Dubois-Martin')).toBe('Hélène Dubois-Martin')
  })
})