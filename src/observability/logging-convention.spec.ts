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

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// --- THE RULE ----------------------------------------------------------------------------------------------

// No log line names a person, and none prints a URL with its query string
// (decisions §32: the logs leave the server — Better Stack's agent ships
// them, and Better Stack is not HIPAA compliant). The logger's hook turns any
// address it sees into "[email]" (logger-options.ts) — a net for what a
// library writes into an error message. THIS test keeps our own code from
// relying on the net: a log line names an account by its id, and a URL by
// its path (pathOnly).
//
// HOW — by reading the source, like the frontend's failureText convention
// test: every call of a Nest Logger method (`this.logger.error(…)`,
// `this.log.warn(…)`) and every `new Error(…)` (its message ends up in a log
// line: the callers log `errorMessage(error)`), in every non-test file under
// src/. Inside the call's arguments, an interpolation `${…}` that mentions an
// email, or a recipient (`to`, `….to`), fails; so does a raw `request.url` /
// `req.url` / `originalUrl` not wrapped in pathOnly(…). A source scan can't
// see everything (a variable named `address`, a helper that returns an
// email) — the review and the hook are the other two nets.

// Files allowed to break the rule, each with its reason.
const EXEMPT: Record<string, string> = {
  // The development transport PRINTS each email instead of sending it —
  // address and body — so a developer can read it. Refused when
  // NODE_ENV=production (email-transport.config.ts), so nothing it prints
  // ever reaches a shipped log.
  'email/transports/log.transport.ts': 'development only',
}

const SRC = join(__dirname, '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
      ? [path]
      : []
  })
}

// --- READING CALLS -----------------------------------------------------------------------------------------

const CALL =
  /(?:\blogger|\.log)\.(?:log|error|warn|debug|verbose|fatal)\(|\bnew Error\(/g

// The text between a call's "(" and its matching ")". Brackets inside
// strings and template literals are skipped; `${…}` inside a template is
// code again, so its brackets count. Good enough for this codebase's
// formatting — not a full parser.
function argumentsAt(source: string, open: number): string {
  let depth = 0
  let quote: string | null = null
  const templates: number[] = [] // brace depth at which each open `${` began
  for (let i = open; i < source.length; i++) {
    const char = source[i]
    if (quote) {
      if (char === '\\') {
        i++
      } else if (quote === '`' && char === '$' && source[i + 1] === '{') {
        templates.push(depth)
        quote = null
        depth++
        i++
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
    } else if (char === '(' || char === '{' || char === '[') {
      depth++
    } else if (char === ')' || char === '}' || char === ']') {
      depth--
      if (char === '}' && templates.at(-1) === depth) {
        templates.pop()
        quote = '`'
      } else if (depth === 0) {
        return source.slice(open + 1, i)
      }
    }
  }
  throw new Error(`Unbalanced call at offset ${open}`)
}

// Comments describe calls without making them (error-message.ts shows the
// old, wrong shape as an example). Each `// …` to the end of its line is
// blanked — replaced by spaces, so offsets and line numbers stay right. Only
// a `//` at the start of a line's code: one inside a string (a URL's
// `https://`) is left alone.
function withoutLineComments(source: string): string {
  return source.replace(/^(\s*)\/\/.*$/gm, (line, indent: string) =>
    indent.padEnd(line.length, ' '),
  )
}

// What's wrong with one call's arguments, or null.
// (A constant in capitals — EMAIL_TRANSPORT_KINDS — is a setting's name,
// not someone's address: left out of the email check.)
function problemIn(args: string): string | null {
  for (const [, expression] of args.matchAll(/\$\{([^}]*)\}/g)) {
    const variables = expression.replace(/\b[A-Z][A-Z0-9_]+\b/g, '')
    if (/e-?mail/i.test(variables) || /(?:^|\.)to\s*$/.test(expression)) {
      return `interpolates \${${expression}} — log the account's id instead`
    }
  }
  const withoutPathOnly = args.replace(/pathOnly\([^)]*\)/g, '')
  if (/\b(?:request|req)\.url\b|\boriginalUrl\b/.test(withoutPathOnly)) {
    return 'prints a URL with its query string — wrap it in pathOnly()'
  }
  return null
}

function violations(): string[] {
  const found: string[] = []
  for (const file of sourceFiles(SRC)) {
    const name = relative(SRC, file).split('\\').join('/')
    if (EXEMPT[name]) continue
    const source = withoutLineComments(readFileSync(file, 'utf8'))
    for (const match of source.matchAll(CALL)) {
      const open = match.index + match[0].length - 1
      const problem = problemIn(argumentsAt(source, open))
      if (problem) {
        const line = source.slice(0, match.index).split('\n').length
        found.push(`${name}:${line} ${problem}`)
      }
    }
  }
  return found
}

// --- TESTS -------------------------------------------------------------------------------------------------

describe('logging convention', () => {
  it('no log line or error message names an address or prints a query string', () => {
    expect(violations()).toStrictEqual([])
  })

  // The scan must SEE what it forbids — checked on the shapes the old code
  // had (a scan that finds nothing anywhere would also pass the test above).
  describe('what the scan recognises', () => {
    it.each([
      '`Failed to send the invitation email to ${account.email}: ${errorMessage(error)}`',
      '`Email sent to ${email.to} (SMTP message id: ${info.messageId})`',
      '`Failed to send the ${what} to ${to}: ${errorMessage(error)}`',
      '`Failed to send the notice to ${outcome.oldEmail}`',
    ])('an address: %s', (args) => {
      expect(problemIn(args)).toMatch(/^interpolates /)
    })

    it.each([
      '{ err }, `Unhandled exception on ${request.method} ${request.url}`',
      '`Unhandled on ${req.url}`',
      '`Unhandled on ${request.originalUrl}`',
    ])('a URL: %s', (args) => {
      expect(problemIn(args)).toBe(
        'prints a URL with its query string — wrap it in pathOnly()',
      )
    })

    it.each([
      '`Failed to send the invitation email to user ${account.id}: ${errorMessage(error)}`',
      '`Unhandled exception on ${request.method} ${pathOnly(request.originalUrl ?? request.url)}`',
      '`Sent ${sent} new-message email(s)`',
      '`Could not delete unreferenced object "${objectKey}"`',
      "{ err: error }, 'The new-message email sweep failed'",
    ])('and leaves alone: %s', (args) => {
      expect(problemIn(args)).toBeNull()
    })

    it('leaves a capitalised constant alone, not a variable', () => {
      expect(
        problemIn("`one of ${EMAIL_TRANSPORT_KINDS.join(', ')}`"),
      ).toBeNull()
      expect(problemIn('`to ${userEmail}`')).toMatch(/^interpolates /)
    })

    it('blanks whole-line comments, keeping lines and offsets', () => {
      const source =
        "a()\n  // this.logger.error(`to ${user.email}`)\nb('https://x')"
      const blanked = withoutLineComments(source)
      expect(blanked).toBe(`a()\n${' '.repeat(42)}\nb('https://x')`)
    })

    // The argument reader: brackets inside strings and templates don't end
    // the call; a `${…}` inside a template is read as code.
    it('reads a whole call, nested brackets and templates included', () => {
      const source =
        "this.logger.error({ err: e }, `a (b) ${f(g)} [c]`, ')') + tail()"
      expect(argumentsAt(source, source.indexOf('('))).toBe(
        "{ err: e }, `a (b) ${f(g)} [c]`, ')'",
      )
    })
  })
})
