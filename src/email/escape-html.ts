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

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// The five characters that mean something in HTML, and their entities.
// Replaced in ONE pass (one regex, this lookup table), so each original
// character is replaced exactly once. The classic bug with chained
// .replace() calls is ordering: escape "<" to "&lt;" first, then "&" to
// "&amp;", and the result is "&amp;lt;" — a visible "&lt;" in the email.
const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

// --- FUNCTION ----------------------------------------------------------------------------------------------

// Makes text safe to put inside an HTML email, as text or inside a quoted
// attribute. Every value a PERSON typed (a first name, a clinic name) goes
// through this before it reaches an email's HTML body: without it, a "first
// name" such as `<a href="https://evil.example">Click here</a>` becomes a
// real link in the recipient's inbox, sent from Stride's own address —
// HTML injection, the email cousin of XSS.
//
// The plain-text body needs none of this: text is never interpreted.
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char])
}
