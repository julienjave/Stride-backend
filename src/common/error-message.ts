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

// --- HELPERS -----------------------------------------------------------------------------------------------

// The human-readable message of whatever was thrown. In JavaScript
// anything can be thrown — an Error, a string, an object — so `catch
// (error)` gives `unknown`, and `.message` can't be read without checking.
//
// What it's for: putting the REASON into a log line's text —
//   this.logger.error(`Failed to send … to ${to}: ${errorMessage(error)}`)
// — rather than passing the error as a second argument. With nestjs-pino
// (this app's logger), extra arguments after the message are values to
// substitute into it, printf-style (`%s`); a message without `%s` simply
// drops them, so `logger.error('Failed', error)` logs "Failed" and nothing
// about why. (Found 2026-10-07 by stopping the SMTP server in a live test.)
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
