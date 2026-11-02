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

// The "port" in a ports-and-adapters split: the one shape every way of
// delivering an email has to fit. EmailService decides WHAT an email says
// (subject, body, the link inside it); a transport only decides HOW it
// leaves the app — Resend's HTTP API in production, the console in dev, an
// in-memory array in the e2e tests (test/support/in-memory-email-transport.ts),
// and later SMTP to Mailpit. EmailService depends on this interface and
// never on a specific vendor, so adding or swapping a transport never
// touches the code that writes emails.

// --- TYPES -------------------------------------------------------------------------------------------------

// An image that travels INSIDE the email (branded emails, decisions §41 —
// the logo). The HTML points at it with `<img src="cid:<contentId>">`: "cid"
// is the MIME standard's Content-ID, the name a part of the same message is
// known by. So the email app shows it from the message itself — no remote
// fetch, so nothing to block behind "load images", and no request that would
// tell a server when the email was opened.
//
// Not a vendor's shape: each transport translates it into its own (nodemailer
// calls the id `cid`, Resend calls it `contentId`), the same way they
// translate the rest of OutgoingEmail.
export interface InlineImage {
  // The name the HTML refers to: `cid:stride-logo-light`. Unique within one
  // email.
  contentId: string
  // Shown if an app lists the part as an attachment after all.
  filename: string
  contentType: 'image/png'
  content: Buffer
}

// A fully built email, ready to hand over. Both an HTML and a plain-text
// body: mail clients that can't (or are set not to) render HTML show the
// text part, spam filters treat HTML-only mail as more suspicious, and the
// text part is also what the dev console transport prints.
export interface OutgoingEmail {
  from: string
  to: string
  subject: string
  html: string
  text: string
  // The images the HTML shows by `cid:`. Optional: an email with none is
  // still an email (the transports' own specs send plain ones), and a
  // transport that can't carry them (the console one) simply ignores them —
  // the text part has no images anyway.
  inlineImages?: readonly InlineImage[]
}

// Resolves once the email has been accepted for delivery; REJECTS if it
// wasn't. Transports never swallow failures themselves — whether a failed
// send should be logged and ignored (a password reset, fire-and-forget) or
// reported back to the person who triggered it (an invitation) is the
// caller's decision, not the transport's.
export interface EmailTransport {
  send(email: OutgoingEmail): Promise<void>
}

// --- INJECTION TOKEN ---------------------------------------------------------------------------------------

// An interface is erased when TypeScript compiles to JavaScript, so Nest
// can't use it as a lookup key at runtime the way it uses a class. A
// Symbol is a unique runtime value that stands in for it: EmailModule
// registers "the transport" under this token, EmailService asks for it with
// @Inject(EMAIL_TRANSPORT), and an e2e test replaces it with
// overrideProvider(EMAIL_TRANSPORT). Same pattern as DRIZZLE in
// drizzle.provider.ts.
export const EMAIL_TRANSPORT = Symbol('EMAIL_TRANSPORT')
