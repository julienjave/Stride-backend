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

// Addresses that can NEVER receive email (decisions §46, pass 2).
//
// Some names are reserved so that examples and tests can use them safely —
// nobody can ever own them:
//   - RFC 2606: the top-level domains `.test`, `.example`, `.invalid`,
//     `.localhost`, and the domains `example.com`, `example.net`,
//     `example.org`;
//   - RFC 6761 confirms them, and that resolvers treat them specially.
// The seed's accounts are all `@stride.test`; the e2e tests use
// `@example.com`. In the reviewers' demo (a real Resend account, a verified
// sending domain), an email to one of them is handed to Resend, which
// accepts it, tries to deliver it, and records a BOUNCE — and a sending
// domain's reputation drops with its bounce rate. So the real provider's
// transport refuses them before the request (resend.transport.ts).
//
// A subdomain counts too (`mail.example.com`, `a.b.test`). Case doesn't
// matter in a domain name (DNS compares without case), so it's lowercased.

const RESERVED_TOP_LEVEL = ['test', 'example', 'invalid', 'localhost']
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org']

export function hasReservedDomain(address: string): boolean {
  // The domain is everything after the LAST "@" (a quoted local part may
  // contain one); a trailing dot is DNS's absolute form of the same name.
  const domain = address
    .slice(address.lastIndexOf('@') + 1)
    .toLowerCase()
    .replace(/\.$/, '')
  const labels = domain.split('.')
  if (RESERVED_TOP_LEVEL.includes(labels[labels.length - 1])) return true
  return RESERVED_DOMAINS.some(
    (reserved) => domain === reserved || domain.endsWith(`.${reserved}`),
  )
}
