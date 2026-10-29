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
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, isNull, lt, sql, type SQL } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import {
  patientProfiles,
  RECORDS_EXPORT_DOB_ATTEMPTS,
  recordsExportLinks,
  userRoles,
  users,
} from '../database/schema'
import {
  applyUserContext,
  withRecordsExportTokenContext,
  withRlsContext,
} from '../database/rls-context'
import {
  isSerializationFailure,
  isUniqueViolation,
  RECORDS_EXPORT_LINKS_ONE_OPEN,
} from '../database/pg-errors'
import { AuditService } from '../audit/audit.service'
import { EmailService } from '../email/email.service'
import { errorMessage } from '../common/error-message'
import { UserRole } from '../users/dto/create-user.dto'
import {
  RecordsExportService,
  type RecordExport,
} from './records-export.service'
import {
  recordsExportLinkStatus,
  type RecordsExportLinkStatus,
} from './records-export-link-status'

// --- CONSTANTS ---------------------------------------------------------------------------------------------

// How long a link works (the person's choice, decisions §20): long enough
// for a weekend, short enough that an old email in an inbox is no longer a
// way into the record.
export const RECORDS_EXPORT_LINK_VALIDITY_HOURS = 72

// When a link sent at `from` stops working: exactly 72 hours later, in SQL
// (hours, not days: a fixed length whatever the time zone — the
// invitations' daylight-saving lesson).
export function recordsExportLinkExpiry(from: SQL): SQL {
  return sql`${from} + make_interval(hours => ${RECORDS_EXPORT_LINK_VALIDITY_HOURS})`
}

export const LINK_NOT_VALID_MESSAGE = 'This download link is not valid'

export const WRONG_DATE_OF_BIRTH_MESSAGE =
  "This date of birth doesn't match the one on file."

// Why a link can no longer be used — sent as `reason` in the 410's body, so
// the page can show the right next step without parsing the English.
type UnusableStatus = Exclude<RecordsExportLinkStatus, 'open'>

const UNUSABLE_MESSAGES: Record<UnusableStatus, string> = {
  used: 'This link has already been used. Ask your clinic for a new one if you need another copy.',
  replaced:
    'This link was replaced by a newer one. Use the most recent email from your clinic.',
  locked:
    'Too many wrong dates of birth: this link no longer works. Ask your clinic for a new one.',
  expired: 'This link has expired. Ask your clinic for a new one.',
}

// --- TYPES -------------------------------------------------------------------------------------------------

export interface PersonRef {
  id: number
  firstName: string
  lastName: string
}

// One link as the API returns it — to an admin. Never the token or its hash.
export interface RecordsExportLinkSummary {
  id: number
  status: RecordsExportLinkStatus
  createdAt: Date
  expiresAt: Date
  // NULL: the email couldn't be sent.
  emailSentAt: Date | null
  usedAt: Date | null
  replacedAt: Date | null
  dateOfBirthFailures: number
  sentBy: PersonRef
}

// What "send" returns: the new link, and whether its email went out. A
// failed email doesn't fail the request (as for invitations): the link
// exists, and the screen can offer to send another.
export interface SentRecordsExportLink extends RecordsExportLinkSummary {
  emailSent: boolean
}

// The patient a link is about, as the send needs them.
interface LinkPatient {
  id: number
  email: string
  firstName: string
  isActive: boolean
  passwordHash: string | null
}

// The signed-in admin.
interface Actor {
  id: number
  activeRole: UserRole
}

// A link as the download page's requests find it, with the DATABASE's
// now() — the clock the guard trigger judges expiry by.
interface FoundLink {
  id: number
  patientId: number
  usedAt: Date | null
  replacedAt: Date | null
  dobFailures: number
  expiresAt: Date
  now: Date
}

// Thrown INSIDE the download's transaction when the date of birth is wrong:
// not an HTTP answer yet. The transaction rolls back (nothing of the copy
// happened), and download() catches it to count the failure in a
// transaction of its own — whose outcome decides the answer (a 400 with the
// tries left, or the 410 that ends the link).
class WrongDateOfBirth extends Error {}

// --- HELPERS -----------------------------------------------------------------------------------------------

// SHA-256 of the raw token, as stored in token_hash — plain SHA-256, as for
// invitations: a 256-bit random token can't be guessed however fast the
// hash, and a deterministic hash is what makes "which link is this?" an
// indexed lookup.
export function hashRecordsExportToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

function gone(status: UnusableStatus): GoneException {
  return new GoneException({
    message: UNUSABLE_MESSAGES[status],
    reason: status,
  })
}

// The partial unique index's WHERE (records_export_links_one_open_per_patient)
// — what "open" means to the database. Expiry is not part of it: an expired
// link is still closed by the next send, which keeps "one open link" true.
function openLink() {
  return and(
    isNull(recordsExportLinks.usedAt),
    isNull(recordsExportLinks.replacedAt),
    lt(recordsExportLinks.dobFailures, RECORDS_EXPORT_DOB_ATTEMPTS),
  )
}

// Runs a REPEATABLE READ transaction, and once more if Postgres refuses it
// with a serialization failure (40001). The price of one snapshot: if
// another transaction changed a row and committed after this one's snapshot
// was taken, changing that row here can't be allowed on a version this
// transaction never saw. The cure (the Postgres manual's) is to run the
// whole transaction again from a fresh snapshot — it then sees what changed
// and answers accordingly. Once: a second conflict in the same instant would
// need yet another writer.
async function retriedOnce<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt()
  } catch (error) {
    if (!isSerializationFailure(error)) throw error
    return attempt()
  }
}

// --- SERVICE -----------------------------------------------------------------------------------------------

// The records export's EMAILED LINK (decisions §20, pass 2) — for a patient
// who can't sign in (deactivated, or who never chose a password) and asks
// the clinic for their record. An admin sends a link to the address on file;
// whoever opens it types the patient's date of birth; the right one
// downloads the record — once, within 72 hours. Five wrong ones end the
// link.
//
// Why both a link AND a date of birth: the link proves access to the
// patient's inbox; the date proves the person at the keyboard knows the
// patient — a forwarded or misdirected email alone doesn't open the record.
// Neither is strong on its own (a date of birth can be found out), which is
// why the tries are few and the link short-lived.
@Injectable()
export class RecordsExportLinksService {
  private readonly logger = new Logger(RecordsExportLinksService.name)

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly recordsExportService: RecordsExportService,
    private readonly emailService: EmailService,
    private readonly auditService: AuditService,
  ) {}

  // === MANAGING LINKS (an admin, signed in) ================================

  // --- GET /users/:id/records-export-links ---

  // Every link ever sent to this patient, newest first — the open one (if
  // any) and the history behind it.
  async list(
    patientId: number,
    actor: Actor,
  ): Promise<RecordsExportLinkSummary[]> {
    await this.findPatient(patientId)
    return this.findSummaries(actor, { patientId })
  }

  // --- POST /users/:id/records-export-links ---

  // Sends a link: the first one, or a new one replacing the open one — the
  // same act from the admin's point of view. For ANY patient, signed in or
  // not (the person's choice): people ask the clinic without checking
  // whether they could download it themselves, and the email tells those
  // who can where to find it next time.
  async send(patientId: number, actor: Actor): Promise<SentRecordsExportLink> {
    const patient = await this.findPatient(patientId)

    let issued: { linkId: number; token: string }
    try {
      issued = await withRlsContext(this.db, actor, async (tx) => {
        const replaced = await tx
          .update(recordsExportLinks)
          .set({ replacedAt: sql`now()` })
          .where(and(eq(recordsExportLinks.patientId, patientId), openLink()))
          .returning({ id: recordsExportLinks.id })

        // 32 random bytes = 256 bits: the raw token exists only here and in
        // the email; the database keeps its hash.
        const token = randomBytes(32).toString('hex')
        const [link] = await tx
          .insert(recordsExportLinks)
          .values({
            patientId,
            tokenHash: hashRecordsExportToken(token),
            sentBy: actor.id,
            // The database's clock, like created_at (set by the trigger) and
            // the download's check: one clock for all three.
            expiresAt: recordsExportLinkExpiry(sql`now()`),
          })
          .returning()

        // ONE entry, in this transaction: the new link and — when there was
        // one — the link it replaced. Where it was sent is part of the
        // trail: "a copy of this record went to which address?" must have an
        // answer even after the account's email changes.
        await this.auditService.logInTransaction(tx, {
          performedBy: actor.id,
          action: 'RECORDS_EXPORT_LINK_SENT',
          targetUserId: patientId,
          entityType: 'records_export_links',
          entityId: link.id,
          details: {
            sentTo: patient.email,
            patientActive: patient.isActive,
            expiresAt: link.expiresAt,
            ...(replaced.length > 0 ? { replacedLinkId: replaced[0].id } : {}),
          },
        })
        return { linkId: link.id, token }
      })
    } catch (error) {
      // Two sends at the same moment: each closed what it saw open and
      // inserted a new link; the partial unique index refused the second.
      if (isUniqueViolation(error, RECORDS_EXPORT_LINKS_ONE_OPEN)) {
        throw new ConflictException(
          'Another link for this patient was sent at the same moment. Refresh to see it.',
        )
      }
      throw error
    }

    // After the commit: the link exists whatever happens to the email
    // (sent before, a failed commit would leave a link to nothing).
    const emailSent = await this.deliver(
      issued.linkId,
      patient,
      issued.token,
      actor,
    )
    const [summary] = await this.findSummaries(actor, { linkId: issued.linkId })
    return { ...summary, emailSent }
  }

  // === USING A LINK (no session: the token is the credential) =============

  // --- POST /records-export/download ---

  // The record, through the link, for the right date of birth. ONE
  // transaction, at REPEATABLE READ (the copy's one moment): the link
  // checked, the date compared, the link spent, the record read and drawn,
  // RECORDS_EXPORTED written — all or nothing. A copy that fails to draw
  // leaves the link unused.
  //
  // A wrong date of birth throws WrongDateOfBirth out of that transaction
  // (rolled back: nothing happened), and is counted AFTERWARDS in a
  // transaction of its own — the step-up's pattern (StepUpAttempt.failed): a
  // failure counted inside the rolled-back transaction would vanish with
  // it. Two requests with the same link at once (a double click): the second
  // meets a serialization failure, runs again (retriedOnce, above), and is
  // told the link has been used.
  async download(
    rawToken: string,
    dateOfBirth: string,
    timeZone: string,
  ): Promise<RecordExport> {
    const tokenHash = hashRecordsExportToken(rawToken)
    const attempt = () =>
      withRecordsExportTokenContext(
        this.db,
        tokenHash,
        (tx) =>
          this.downloadInTransaction(tx, tokenHash, dateOfBirth, timeZone),
        { isolationLevel: 'repeatable read' },
      )
    try {
      return await retriedOnce(attempt)
    } catch (error) {
      if (error instanceof WrongDateOfBirth) {
        throw await this.countWrongDateOfBirth(tokenHash)
      }
      throw error
    }
  }

  // === PRIVATE ============================================================

  private async downloadInTransaction(
    tx: DrizzleDb,
    tokenHash: string,
    dateOfBirth: string,
    timeZone: string,
  ): Promise<RecordExport> {
    const link = await this.findLink(tx, tokenHash)
    const status = recordsExportLinkStatus(link, link.now)
    if (status !== 'open') throw gone(status)

    // patient_profiles is readable by every session (migration 0010); a
    // `date` column reads back as 'YYYY-MM-DD' — the DTO's own format, so
    // the comparison is between two strings of one shape.
    const [profile] = await tx
      .select({ dateOfBirth: patientProfiles.dateOfBirth })
      .from(patientProfiles)
      .where(eq(patientProfiles.userId, link.patientId))
    if (profile?.dateOfBirth !== dateOfBirth) throw new WrongDateOfBirth()

    // From here the transaction ALSO acts as the patient: the record is read
    // through the patient's own policies, exactly as when they download it
    // signed in. The token setting stays: spending the link below is the
    // token holder's act (the guard trigger checks it).
    await applyUserContext(tx, {
      id: link.patientId,
      activeRole: UserRole.PATIENT,
    })

    // Spent. No "AND still open" in the WHERE, unlike invitations' accept:
    // at REPEATABLE READ the row can't have changed since the check above
    // without this UPDATE failing with 40001 (see download()), and the
    // guard trigger refuses a closed or expired link whatever happens.
    await tx
      .update(recordsExportLinks)
      .set({ usedAt: sql`now()` })
      .where(eq(recordsExportLinks.id, link.id))

    return this.recordsExportService.exportInTransaction(
      tx,
      link.patientId,
      timeZone,
      { via: 'emailed_link', linkId: link.id },
    )
  }

  // One wrong date of birth: counted, audited — and at the limit, the link
  // is over. ONE transaction as the token holder (read committed: nothing
  // here needs the copy's one moment). `+ 1` computed by the database in a
  // single UPDATE, under the row's lock: two wrong tries at once both count.
  // Answers with the exception to throw.
  private async countWrongDateOfBirth(
    tokenHash: string,
  ): Promise<HttpException> {
    const outcome = await withRecordsExportTokenContext<
      { closedAs: UnusableStatus } | { failures: number }
    >(this.db, tokenHash, async (tx) => {
      const [counted] = await tx
        .update(recordsExportLinks)
        .set({ dobFailures: sql`${recordsExportLinks.dobFailures} + 1` })
        .where(and(eq(recordsExportLinks.tokenHash, tokenHash), openLink()))
        .returning({
          id: recordsExportLinks.id,
          patientId: recordsExportLinks.patientId,
          dobFailures: recordsExportLinks.dobFailures,
        })
      // Closed in between (used, replaced, or locked by tries made at the
      // same moment): nothing to count — the answer is why it's closed.
      // Not open means one of the three openLink() rules out.
      if (!counted) {
        const link = await this.findLink(tx, tokenHash)
        const closedAs: UnusableStatus =
          link.usedAt !== null
            ? 'used'
            : link.replacedAt !== null
              ? 'replaced'
              : 'locked'
        return { closedAs }
      }

      const locked = counted.dobFailures >= RECORDS_EXPORT_DOB_ATTEMPTS
      // Performed by the patient: nobody is signed in, and the link was
      // emailed to them — the same reading as LOGIN_FAILURE, recorded
      // against the account whose password was tried. No date of birth in
      // the entry, right or wrong.
      await this.auditService.logInTransaction(tx, {
        performedBy: counted.patientId,
        action: 'RECORDS_EXPORT_LINK_REFUSED',
        targetUserId: counted.patientId,
        entityType: 'records_export_links',
        entityId: counted.id,
        details: {
          wrongDatesOfBirth: counted.dobFailures,
          ...(locked ? { linkLocked: true } : {}),
        },
      })
      return { failures: counted.dobFailures }
    })

    if ('closedAs' in outcome) return gone(outcome.closedAs)
    if (outcome.failures >= RECORDS_EXPORT_DOB_ATTEMPTS) return gone('locked')
    // How many tries are left, for the page to say so: the limit is no
    // secret (the email states it), and a patient who mistyped deserves to
    // know before the last one.
    return new BadRequestException({
      message: WRONG_DATE_OF_BIRTH_MESSAGE,
      attemptsLeft: RECORDS_EXPORT_DOB_ATTEMPTS - outcome.failures,
    })
  }

  // The link with this token hash — the only one the token context can see
  // anyway — with the database's now(). 404 when there is none: a wrong or
  // mistyped link.
  private async findLink(tx: DrizzleDb, tokenHash: string): Promise<FoundLink> {
    const [link] = await tx
      .select({
        id: recordsExportLinks.id,
        patientId: recordsExportLinks.patientId,
        usedAt: recordsExportLinks.usedAt,
        replacedAt: recordsExportLinks.replacedAt,
        dobFailures: recordsExportLinks.dobFailures,
        expiresAt: recordsExportLinks.expiresAt,
        // mapWith: read back through the timestamp column's own conversion,
        // so it arrives as a Date like expiresAt — not as a string.
        now: sql`now()`.mapWith(recordsExportLinks.expiresAt),
      })
      .from(recordsExportLinks)
      .where(eq(recordsExportLinks.tokenHash, tokenHash))
    if (!link) throw new NotFoundException(LINK_NOT_VALID_MESSAGE)
    return link
  }

  // The patient a link would be about — or why there is none. users and
  // user_roles are readable without a session context (migrations 0007,
  // 0009).
  private async findPatient(patientId: number): Promise<LinkPatient> {
    const [account] = await this.db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        isActive: users.isActive,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(eq(users.id, patientId))
    if (!account) throw new NotFoundException(`User ${patientId} not found`)
    const [role] = await this.db
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(
        and(
          eq(userRoles.userId, patientId),
          eq(userRoles.role, UserRole.PATIENT),
        ),
      )
    if (!role) {
      throw new BadRequestException(
        'Only a patient has a health record to send',
      )
    }
    return account
  }

  // Emails a link. Never throws: a failure is logged and reported as false
  // — the link is already saved, and the admin can send another.
  //
  // On success, records WHEN (email_sent_at), as the admin, so the screen
  // can tell later whether the email ever went out.
  private async deliver(
    linkId: number,
    patient: LinkPatient,
    rawToken: string,
    actor: Actor,
  ): Promise<boolean> {
    try {
      await this.emailService.sendRecordsExportLinkEmail({
        to: patient.email,
        firstName: patient.firstName,
        rawToken,
        validForHours: RECORDS_EXPORT_LINK_VALIDITY_HOURS,
        dateOfBirthAttempts: RECORDS_EXPORT_DOB_ATTEMPTS,
        // Can they download it themselves? Only an ACTIVE account that has
        // a password can sign in.
        canSignIn: patient.isActive && patient.passwordHash !== null,
      })
    } catch (error) {
      this.logger.error(
        `Failed to send the records export link to ${patient.email}: ${errorMessage(error)}`,
      )
      return false
    }

    // The email has gone out: the answer is true whatever happens to the
    // record of it (an email can't be un-sent). If only the record fails,
    // the screen says "couldn't be sent" for an email that went —
    // misleading but harmless — so it's logged, not thrown.
    try {
      await withRlsContext(this.db, actor, (tx) =>
        tx
          .update(recordsExportLinks)
          .set({ emailSentAt: sql`now()` })
          .where(eq(recordsExportLinks.id, linkId)),
      )
    } catch (error) {
      this.logger.error(
        `The records export link to ${patient.email} was sent, but recording that failed: ${errorMessage(error)}`,
      )
    }
    return true
  }

  // The links of one patient, or one link, with who sent each — as the
  // admin (the select policy's admin branch).
  private async findSummaries(
    actor: Actor,
    filter: { patientId: number } | { linkId: number },
  ): Promise<RecordsExportLinkSummary[]> {
    const rows = await withRlsContext(this.db, actor, (tx) =>
      tx
        .select({
          link: recordsExportLinks,
          sentBy: {
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
          },
          now: sql`now()`.mapWith(recordsExportLinks.createdAt),
        })
        .from(recordsExportLinks)
        .innerJoin(users, eq(users.id, recordsExportLinks.sentBy))
        .where(
          'patientId' in filter
            ? eq(recordsExportLinks.patientId, filter.patientId)
            : eq(recordsExportLinks.id, filter.linkId),
        )
        // One link per send, one send per transaction: no two links share
        // a created_at, so no tie to break.
        .orderBy(desc(recordsExportLinks.createdAt)),
    )
    return rows.map(({ link, sentBy, now }) => ({
      id: link.id,
      status: recordsExportLinkStatus(link, now),
      createdAt: link.createdAt,
      expiresAt: link.expiresAt,
      emailSentAt: link.emailSentAt,
      usedAt: link.usedAt,
      replacedAt: link.replacedAt,
      dateOfBirthFailures: link.dobFailures,
      sentBy,
    }))
  }
}
