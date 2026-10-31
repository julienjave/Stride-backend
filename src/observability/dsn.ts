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

// A DSN ("Data Source Name") is the one setting an error-reporting SDK needs:
// WHERE reports go and WHICH project they belong to, written as a URL —
//
//   http://3f1c…9a@glitchtip:8000/2
//   └┬─┘  └──┬───┘ └───┬───────┘ └ the project's id
//    │       │         └ the server (GlitchTip on Docker's network)
//    │       └ the project's PUBLIC key (not a secret: browsers send it too)
//    └ the protocol
//
// Sentry and GlitchTip speak the same protocol, so a DSN from either works.
// Read here, once: the backend's SDK gets its own (SENTRY_DSN), and the
// browser's reports, which arrive through our POST /monitoring, are checked
// against the frontend project's (SENTRY_BROWSER_DSN) before being forwarded
// — to the host written in that same DSN.

export interface Dsn {
  protocol: 'http' | 'https'
  publicKey: string
  // host[:port], as written
  host: string
  // a path BEFORE the project id, when the server lives under one
  // ("https://key@example.com/errors/2" → "/errors"); usually ''
  pathPrefix: string
  projectId: string
}

// The DSN's parts, or a thrown Error naming the setting — read at boot by
// validateEnv(), so a mistyped DSN stops the app instead of silently losing
// every report.
export function parseDsn(text: string, setting: string): Dsn {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error(
      `${setting} is not a valid URL: expected http(s)://<key>@<host>/<project id>`,
    )
  }
  const protocol = url.protocol.slice(0, -1)
  if (protocol !== 'http' && protocol !== 'https') {
    throw new Error(`${setting} must start with http:// or https://`)
  }
  if (!url.username || url.password) {
    throw new Error(
      `${setting} must hold the project's public key before the @, and nothing else`,
    )
  }
  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  const projectId = segments.pop()
  if (!projectId || !/^\d+$/.test(projectId)) {
    throw new Error(`${setting} must end with the project's numeric id`)
  }
  if (url.search || url.hash) {
    throw new Error(`${setting} must not have a query string or a fragment`)
  }
  return {
    protocol,
    publicKey: decodeURIComponent(url.username),
    host: url.host,
    pathPrefix: segments.length > 0 ? `/${segments.join('/')}` : '',
    projectId,
  }
}

// Whether two DSNs name the same project with the same key — how the tunnel
// recognises an envelope meant for OUR frontend project (and nothing else:
// the tunnel isn't a relay for anyone's reports).
export function sameProject(a: Dsn, b: Dsn): boolean {
  return (
    a.publicKey === b.publicKey &&
    a.host === b.host &&
    a.pathPrefix === b.pathPrefix &&
    a.projectId === b.projectId
  )
}

// Where a project's envelopes are POSTed: Sentry's ingestion address,
// `/api/<project id>/envelope/`, which GlitchTip serves too.
export function envelopeUrl(dsn: Dsn): string {
  return `${dsn.protocol}://${dsn.host}${dsn.pathPrefix}/api/${dsn.projectId}/envelope/`
}

// The header that tells the server which project's key the envelope uses —
// the same one the SDKs send.
export function authHeader(dsn: Dsn, client: string): string {
  return `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=${client}`
}
