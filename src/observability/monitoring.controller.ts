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

import {
  BadGatewayException,
  BadRequestException,
  Controller,
  ForbiddenException,
  HttpCode,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  Post,
  Req,
  UnsupportedMediaTypeException,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import type { Request } from 'express'
import { NotAudited } from '../common/decorators/not-audited.decorator'
import { errorMessage } from '../common/error-message'
import { authHeader, type Dsn, envelopeUrl } from './dsn'
import {
  EnvelopeError,
  rewriteBrowserEnvelope,
  UnknownProjectError,
} from './envelope'
import { errorReportingConfig } from './error-reporting-config'

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// A browser's error report is a few kilobytes; 256 KB leaves room for a long
// stack trace and refuses anything that would make the server buffer a lot.
export const MAX_ENVELOPE_BYTES = 256 * 1024

// The browser SDK's tunnel sends its envelope as text/plain (a "simple"
// request in CORS terms — no preflight); Sentry's own content type is
// accepted too. Anything else (JSON, a form) is refused: Express's parsers
// would already have read it, and it isn't an envelope.
const ENVELOPE_TYPES = ['text/plain', 'application/x-sentry-envelope']

const FORWARD_TIMEOUT_MS = 5_000

export const MONITORING_OFF_MESSAGE =
  'Error reporting is not set up on this server'
export const NOT_AN_ENVELOPE_MESSAGE = 'The body must be a Sentry envelope'
export const UNKNOWN_PROJECT_MESSAGE =
  'This server only accepts reports for its own project'
export const FORWARD_FAILED_MESSAGE = 'The report could not be passed on'

// --- CONTROLLER --------------------------------------------------------------------------------------------

// POST /monitoring — the TUNNEL for the browser's error reports (decisions
// §32). The frontend's SDK is told to send its envelopes here (its `tunnel`
// option) instead of to GlitchTip directly:
//
//   browser ──POST /monitoring──▶ Stride API ──(Docker's network)──▶ GlitchTip
//
// Why a tunnel:
//   - GlitchTip is never on the internet — its login page included; it's
//     reached over an SSH tunnel by whoever reads the reports;
//   - the server applies THE RULE again (report-scrub.ts) — whatever the
//     browser's code did or didn't do — and puts the SESSION's user id on the
//     report, not one the page claims;
//   - ad-blockers drop requests to known error-tracking addresses; a request
//     to the app's own API isn't one.
//
// Public on purpose: an error can happen on the sign-in page, or because the
// session ended. Safeguards instead: only our frontend project's envelopes
// (SENTRY_BROWSER_DSN — never an open relay), 256 KB, 30 a minute per IP,
// error events only.
@Controller('monitoring')
export class MonitoringController {
  private readonly logger = new Logger(MonitoringController.name)
  // Read when the app is built — like every other setting (validateEnv has
  // already checked it at boot).
  private readonly browserDsn: Dsn | null = errorReportingConfig().browserDsn

  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @NotAudited('Passes a browser error report on to GlitchTip; changes no data')
  async receive(@Req() request: Request): Promise<void> {
    if (!this.browserDsn) throw new NotFoundException(MONITORING_OFF_MESSAGE)
    if (!isEnvelopeType(request.headers['content-type'])) {
      throw new UnsupportedMediaTypeException(NOT_AN_ENVELOPE_MESSAGE)
    }
    const body = await readBody(request, MAX_ENVELOPE_BYTES)

    let envelope: Buffer | null
    try {
      envelope = rewriteBrowserEnvelope(
        body,
        this.browserDsn,
        signedInUserId(request),
      )
    } catch (error) {
      if (error instanceof UnknownProjectError) {
        throw new ForbiddenException(UNKNOWN_PROJECT_MESSAGE)
      }
      if (error instanceof EnvelopeError) {
        throw new BadRequestException(NOT_AN_ENVELOPE_MESSAGE)
      }
      throw error
    }
    // Nothing left to pass on (a session update, a client report): done.
    if (!envelope) return
    await this.forward(this.browserDsn, envelope)
  }

  // To the host IN the DSN — in production `glitchtip:8000`, a name only
  // Docker's network knows. The answer's body is not read: GlitchTip says
  // only "accepted".
  private async forward(dsn: Dsn, envelope: Buffer): Promise<void> {
    let response: Response
    try {
      response = await fetch(envelopeUrl(dsn), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-sentry-envelope',
          'X-Sentry-Auth': authHeader(dsn, 'stride-monitoring-tunnel/1.0'),
        },
        // A Uint8Array view of the same bytes: what fetch's types accept.
        body: new Uint8Array(envelope),
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      })
    } catch (error) {
      this.logger.warn(
        `Could not pass a browser error report on: ${errorMessage(error)}`,
      )
      throw new BadGatewayException(FORWARD_FAILED_MESSAGE)
    }
    if (!response.ok) {
      this.logger.warn(
        `GlitchTip refused a browser error report: ${response.status}`,
      )
      throw new BadGatewayException(FORWARD_FAILED_MESSAGE)
    }
  }
}

// --- HELPERS -----------------------------------------------------------------------------------------------

function isEnvelopeType(contentType: string | undefined): boolean {
  const type = contentType?.split(';')[0].trim().toLowerCase()
  return type !== undefined && ENVELOPE_TYPES.includes(type)
}

// The request's body, read from the stream as raw bytes — Nest's parsers
// handle JSON and forms only, so a text/plain body is still unread here. The
// limit is enforced while reading: a 10 MB body is refused after its first
// 256 KB, never held whole in memory.
export async function readBody(
  request: AsyncIterable<Buffer | string>,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += bytes.length
    if (size > limit) {
      throw new PayloadTooLargeException(
        `An error report can be at most ${limit} bytes`,
      )
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

// The signed-in account's id, from passport's session — or null.
function signedInUserId(request: Request): number | null {
  const user: { id?: unknown } | undefined = request.user
  return typeof user?.id === 'number' ? user.id : null
}
