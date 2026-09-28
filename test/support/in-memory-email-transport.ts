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

// --- IMPORTS -----------------------------------------------------------------------------------------------

import type {
  EmailTransport,
  OutgoingEmail,
} from '../../src/email/email-transport'

// --- TRANSPORT ---------------------------------------------------------------------------------------------

// The e2e tests' outbox — a "fake" in test-double terms: a real, working
// implementation of EmailTransport, just one that keeps emails in an array
// instead of delivering them. A suite swaps it in when building the app:
//
//   const outbox = new InMemoryEmailTransport()
//   Test.createTestingModule({ imports: [AppModule] })
//     .overrideProvider(EMAIL_TRANSPORT)
//     .useValue(outbox)
//
// and can then read what the app "sent" — to assert on it, or to follow
// the link inside, exactly like a user clicking it. No network, no Resend
// sandbox rules about which addresses may receive mail, no waiting.
//
// It lives under test/, not src/, so it's never part of the application's
// own code: there is no configuration value that could select it.
export class InMemoryEmailTransport implements EmailTransport {
  readonly sent: OutgoingEmail[] = []

  // Records the email synchronously, the moment send() is called — so an
  // email sent fire-and-forget during a request (forgotPassword() doesn't
  // await its send) is already in `sent` by the time the response arrives,
  // with no polling in the test.
  send(email: OutgoingEmail): Promise<void> {
    this.sent.push(email)
    return Promise.resolve()
  }

  sentTo(address: string): OutgoingEmail[] {
    return this.sent.filter((email) => email.to === address)
  }

  // Throws rather than returning undefined: every caller wants the email to
  // be there, and a clear message beats a later "cannot read properties
  // of undefined" pointing at the wrong line.
  lastSentTo(address: string): OutgoingEmail {
    const emails = this.sentTo(address)
    if (emails.length === 0) {
      throw new Error(`No email was sent to ${address}`)
    }
    return emails[emails.length - 1]
  }
}

// --- HELPERS -----------------------------------------------------------------------------------------------

// Finds the link in an email's plain-text body whose path is `pathname`
// (e.g. '/reset-password') and returns it parsed, so a test reads query
// parameters with url.searchParams.get('token') instead of slicing strings.
// Reads the text part rather than the HTML: same link, no markup to parse.
export function findLink(email: OutgoingEmail, pathname: string): URL {
  // Annotated: `match(...) ?? []` would otherwise type the fallback as
  // any[], and every URL below as `any`.
  const urls: string[] = email.text.match(/https?:\/\/\S+/g) ?? []
  const link = urls
    .map((raw) => new URL(raw))
    .find((url) => url.pathname === pathname)
  if (!link) {
    throw new Error(
      `No ${pathname} link in the email to ${email.to}. Links found: ` +
        (urls.length ? urls.join(', ') : 'none'),
    )
  }
  return link
}