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

import { markup, SafeHtml } from './safe-html'

describe('markup', () => {
  it('keeps the literal parts as written', () => {
    expect(markup`<p class="x">Hello</p>`.toString()).toBe(
      '<p class="x">Hello</p>',
    )
  })

  // The whole point: what was interpolated is text, never markup.
  it('escapes an interpolated string', () => {
    const firstName = '<a href="https://evil.example">Pat</a>'
    expect(markup`<p>Hello ${firstName}</p>`.toString()).toBe(
      '<p>Hello &lt;a href=&quot;https://evil.example&quot;&gt;Pat&lt;/a&gt;</p>',
    )
  })

  it('escapes inside an attribute too', () => {
    const url = 'https://x.test/?a=1&b="2"'
    expect(markup`<a href="${url}">go</a>`.toString()).toBe(
      '<a href="https://x.test/?a=1&amp;b=&quot;2&quot;">go</a>',
    )
  })

  it('writes a number as its digits', () => {
    expect(markup`${7} days`.toString()).toBe('7 days')
  })

  // A SafeHtml was escaped when IT was built: escaping it again would show
  // "&lt;b&gt;" in the email.
  it('inserts a SafeHtml as markup, without escaping it twice', () => {
    const name = '<b>'
    const inner = markup`<b>${name}</b>`
    expect(markup`<p>${inner}</p>`.toString()).toBe('<p><b>&lt;b&gt;</b></p>')
  })

  it('inserts a list of SafeHtml pieces in order, with nothing between', () => {
    const items = [markup`<li>a</li>`, markup`<li>b</li>`]
    expect(markup`<ul>${items}</ul>`.toString()).toBe(
      '<ul><li>a</li><li>b</li></ul>',
    )
  })

  it('places each value between the right literal parts', () => {
    expect(markup`1${'a'}2${'b'}3`.toString()).toBe('1a2b3')
  })

  it('returns a SafeHtml', () => {
    expect(markup`x`).toBeInstanceOf(SafeHtml)
  })
})

describe('SafeHtml', () => {
  // The only door is the markup tag: a SafeHtml made around it — here by
  // casting past the compiler, which refuses `new SafeHtml(…)` without the
  // module's private key — must not exist.
  it('cannot be made without the module key', () => {
    const Unchecked = SafeHtml as unknown as new (
      key: unknown,
      value: string,
    ) => SafeHtml
    expect(() => new Unchecked(Symbol('SafeHtml'), '<script>')).toThrow(
      'SafeHtml is made by the markup tag only',
    )
  })

  it('reads as its HTML when turned into a string', () => {
    expect(String(markup`<i>x</i>`)).toBe('<i>x</i>')
  })
})
