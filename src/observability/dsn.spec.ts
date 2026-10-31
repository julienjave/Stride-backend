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

import { authHeader, envelopeUrl, parseDsn, sameProject } from './dsn'

// The DSN: where reports go and for which project (decisions §32).

describe('parseDsn', () => {
  it('reads the protocol, key, host, project and an optional path', () => {
    expect(
      parseDsn('http://abc123@glitchtip:8000/2', 'SENTRY_DSN'),
    ).toStrictEqual({
      protocol: 'http',
      publicKey: 'abc123',
      host: 'glitchtip:8000',
      pathPrefix: '',
      projectId: '2',
    })
    expect(
      parseDsn('https://k@errors.example.com/team/errors/17', 'SENTRY_DSN'),
    ).toStrictEqual({
      protocol: 'https',
      publicKey: 'k',
      host: 'errors.example.com',
      pathPrefix: '/team/errors',
      projectId: '17',
    })
  })

  // Each refusal names the setting, so the boot error says what to fix.
  it.each([
    [
      'not a url',
      'SENTRY_DSN is not a valid URL: expected http(s)://<key>@<host>/<project id>',
    ],
    ['ftp://k@host/2', 'SENTRY_DSN must start with http:// or https://'],
    [
      'http://host:8000/2',
      "SENTRY_DSN must hold the project's public key before the @, and nothing else",
    ],
    [
      'http://k:secret@host/2',
      "SENTRY_DSN must hold the project's public key before the @, and nothing else",
    ],
    ['http://k@host/', "SENTRY_DSN must end with the project's numeric id"],
    ['http://k@host/abc', "SENTRY_DSN must end with the project's numeric id"],
    [
      'http://k@host/2?x=1',
      'SENTRY_DSN must not have a query string or a fragment',
    ],
    [
      'http://k@host/2#top',
      'SENTRY_DSN must not have a query string or a fragment',
    ],
  ])('refuses %s', (text, message) => {
    expect(() => parseDsn(text, 'SENTRY_DSN')).toThrow(new Error(message))
  })
})

describe('sameProject', () => {
  const base = parseDsn('http://key@glitchtip:8000/2', 'X')
  it('is true for the same key, host, path and project', () => {
    expect(
      sameProject(base, parseDsn('http://key@glitchtip:8000/2', 'X')),
    ).toBe(true)
    // The protocol doesn't name a different project.
    expect(
      sameProject(base, parseDsn('https://key@glitchtip:8000/2', 'X')),
    ).toBe(true)
  })

  it.each([
    'http://other@glitchtip:8000/2',
    'http://key@elsewhere:8000/2',
    'http://key@glitchtip:8000/3',
    'http://key@glitchtip:8000/prefix/2',
  ])('is false for %s', (other) => {
    expect(sameProject(base, parseDsn(other, 'X'))).toBe(false)
  })
})

describe('envelopeUrl and authHeader', () => {
  it("build Sentry's ingestion address and header from the DSN", () => {
    const dsn = parseDsn('https://key@errors.example.com/team/17', 'X')
    expect(envelopeUrl(dsn)).toBe(
      'https://errors.example.com/team/api/17/envelope/',
    )
    expect(authHeader(dsn, 'stride/1.0')).toBe(
      'Sentry sentry_version=7, sentry_key=key, sentry_client=stride/1.0',
    )
  })
})
