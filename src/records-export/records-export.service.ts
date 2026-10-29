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

import { Inject, Injectable } from '@nestjs/common'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import { withRlsContext } from '../database/rls-context'
import { AuditService } from '../audit/audit.service'
import { UserRole } from '../users/dto/create-user.dto'
import {
  buildRecordDocument,
  type CopyMark,
  type DisclosureStamp,
  type ReviewStamp,
} from './record-content'
import { loadRecord } from './record-loader'
import { renderRecordPdf } from './record-pdf'
import { scopeRecord } from './record-scope'

// --- TYPES -------------------------------------------------------------------------------------------------

// What the controller sends: the file, and the name it's saved under.
export interface RecordExport {
  pdf: Buffer
  fileName: string
}

// Which way a copy left — written into its RECORDS_EXPORTED entry:
//   - app: the patient, signed in, from My records;
//   - emailed_link: through the link an admin emailed (which one);
//   - complaint_review: an admin, under an open complaint review (decisions
//     §25, pass 2) — with what the copy's stamp prints;
//   - legal_disclosure: an admin, for a legal disclosure (pass 3) — with the
//     order's details, which also say WHAT the copy holds (its parts and
//     period).
// The last two are the sources not made by the patient: their entries name
// the admin as the one who made the copy.
export type ExportSource =
  | { via: 'app' }
  | { via: 'emailed_link'; linkId: number }
  | { via: 'complaint_review'; adminId: number; stamp: ReviewStamp }
  | { via: 'legal_disclosure'; adminId: number; stamp: DisclosureStamp }

// --- SERVICE -----------------------------------------------------------------------------------------------

// The records export (decisions §20): a patient's right of access (HIPAA 45
// CFR 164.524) met with a COPY — the medical file, the programs and the
// sessions, as one PDF.
//
// The rules it keeps:
//   - ONLY THE PATIENT RECEIVES IT: the patient themselves (GET
//     /records-export), or — for one who can't sign in — through a link an
//     admin emails to the patient's own address, opened with their date of
//     birth (RecordsExportLinksService). Both go through
//     exportInTransaction below. The two exceptions are decided elsewhere,
//     each with its own grant and record (decisions §25): an admin's REVIEW
//     copy under an open complaint review, and a DISCLOSED copy made for a
//     legal order — the same function, told so by its `source`.
//   - MADE ON REQUEST, NEVER STORED. No copy waits in storage: one would be
//     another place holding clinical content, and out of date the next day.
//   - ONE MOMENT. The reads run in a REPEATABLE READ transaction: every
//     statement sees the database as it was at the first one. Under
//     Postgres's default (read committed) each statement sees the latest
//     commits, so a session completed between the program read and the
//     session read could appear without its program, or a note amended
//     half-way could show both versions as current.
//   - NOTHING LEAVES WITHOUT ITS TRACE. The audit entry is written in the
//     same transaction, AFTER the PDF is made and BEFORE the controller
//     sends a byte: a failed drawing rolls everything back (nothing was
//     handed out, nothing is recorded); a failed audit insert fails the
//     request (no copy without its record). The medical files' reads work
//     the same way.
@Injectable()
export class RecordsExportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly auditService: AuditService,
  ) {}

  // --- GET /records-export ---

  // The signed-in patient's own record. `timeZone` is the browser's (the
  // DTO checked it): every moment in the document is written in it.
  async exportOwnRecord(
    patientId: number,
    timeZone: string,
  ): Promise<RecordExport> {
    return withRlsContext(
      this.db,
      { id: patientId, activeRole: UserRole.PATIENT },
      (tx) => this.exportInTransaction(tx, patientId, timeZone, { via: 'app' }),
      { isolationLevel: 'repeatable read' },
    )
  }

  // The copy itself, inside the CALLER's transaction — shared by both ways
  // in: the patient's own download (above) and the emailed link
  // (RecordsExportLinksService), so the two can never hand out different
  // documents. The caller owes it a transaction that:
  //   - acts AS the patient (the patient's own policies decide what is read);
  //   - runs at REPEATABLE READ (one moment — see the class comment).
  // `source` says which way the copy left, for its audit entry.
  async exportInTransaction(
    tx: DrizzleDb,
    patientId: number,
    timeZone: string,
    source: ExportSource,
  ): Promise<RecordExport> {
    // A disclosed copy reads messages only when the order covers them, and
    // never the accounting; then it is narrowed to the order's parts and
    // period BEFORE anything is drawn or recorded — what is out of scope
    // reaches neither the PDF nor the ids below.
    const disclosure =
      source.via === 'legal_disclosure' ? source.stamp : undefined
    const loaded = await loadRecord(tx, patientId, {
      messages: disclosure?.parts.includes('messages') ?? false,
      disclosures: disclosure === undefined,
    })
    const record =
      disclosure === undefined
        ? loaded
        : scopeRecord(loaded, disclosure, timeZone)
    const pdf = await renderRecordPdf(
      buildRecordDocument(record, timeZone, copyMark(source)),
    )

    // What went in, by id — never the content (an audit entry is not a
    // second copy of the record). Enough to answer "what did this patient
    // receive on that day?" — or what an admin's review copy held — even
    // after the record has grown.
    await this.auditService.logInTransaction(tx, {
      performedBy: 'adminId' in source ? source.adminId : patientId,
      action: 'RECORDS_EXPORTED',
      targetUserId: patientId,
      entityType: 'records_exports',
      details: {
        ...sourceDetails(source),
        timeZone,
        medicalFileEntryIds: record.medicalFile.map((entry) => entry.id),
        programIds: record.programs.map((program) => program.id),
        sessionIds: record.programs.flatMap((program) =>
          program.sessions.map((session) => session.id),
        ),
        // Only a disclosed copy can hold messages — and only then is the
        // key written (an absent key: no messages part; an empty list: the
        // part was included, and the period held none).
        ...(record.conversations === undefined
          ? {}
          : {
              messageIds: record.conversations.flatMap((conversation) =>
                conversation.messages.map((message) => message.id),
              ),
            }),
      },
    })

    // A review copy, or a disclosed one, is named for what it was made
    // for: an admin may make several in a day, and "stride-health-record-…"
    // in their Downloads would read as the patient's own copy.
    return {
      pdf,
      fileName: exportFileName(record.madeAt, timeZone, fileNamePrefix(source)),
    }
  }
}

// --- HELPERS -----------------------------------------------------------------------------------------------

// The source as its audit entry records it: which way, and which link or
// review — the review's id only (its reason is in its own entry,
// COMPLAINT_REVIEW_OPENED; the admin is the entry's performed_by).
function sourceDetails(source: ExportSource): Record<string, string | number> {
  switch (source.via) {
    case 'app':
      return { via: 'app' }
    case 'emailed_link':
      return { via: 'emailed_link', linkId: source.linkId }
    case 'complaint_review':
      return { via: 'complaint_review', reviewId: source.stamp.reviewId }
    case 'legal_disclosure':
      return {
        via: 'legal_disclosure',
        disclosureId: source.stamp.disclosureId,
      }
  }
}

// What kind of copy the document is — none for the patient's own.
function copyMark(source: ExportSource): CopyMark | undefined {
  switch (source.via) {
    case 'complaint_review':
      return { kind: 'review', review: source.stamp }
    case 'legal_disclosure':
      return { kind: 'disclosure', disclosure: source.stamp }
    default:
      return undefined
  }
}

function fileNamePrefix(source: ExportSource): string {
  switch (source.via) {
    case 'complaint_review':
      return `stride-review-copy-${source.stamp.reviewId}`
    case 'legal_disclosure':
      return `stride-disclosure-${source.stamp.disclosureId}`
    default:
      return 'stride-health-record'
  }
}

// "stride-health-record-2026-10-26.pdf" — the day of the copy, in the
// patient's zone. 'en-CA' writes a date as YYYY-MM-DD: sortable in a
// Downloads folder, and the same shape on every machine. `prefix`: a review
// copy's ("stride-review-copy-12").
export function exportFileName(
  madeAt: Date,
  timeZone: string,
  prefix = 'stride-health-record',
): string {
  const day = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(madeAt)
  return `${prefix}-${day}.pdf`
}
