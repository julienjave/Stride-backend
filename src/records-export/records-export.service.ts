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
import { buildRecordDocument } from './record-content'
import { loadRecord } from './record-loader'
import { renderRecordPdf } from './record-pdf'

// --- TYPES -------------------------------------------------------------------------------------------------

// What the controller sends: the file, and the name it's saved under.
export interface RecordExport {
  pdf: Buffer
  fileName: string
}

// --- SERVICE -----------------------------------------------------------------------------------------------

// The records export (decisions §20): a patient's right of access (HIPAA 45
// CFR 164.524) met with a COPY — the medical file, the programs and the
// sessions, as one PDF.
//
// The rules it keeps:
//   - ONLY THE PATIENT RECEIVES IT. Pass 1: the patient themselves (GET
//     /records-export). Pass 2 adds an emailed link for one who can't sign
//     in — the same method below, reached through the link.
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
      async (tx) => {
        const record = await loadRecord(tx, patientId)
        const pdf = await renderRecordPdf(buildRecordDocument(record, timeZone))

        // What went in, by id — never the content (an audit entry is not a
        // second copy of the record). Enough to answer "what did this
        // patient receive on that day?" even after the record has grown.
        await this.auditService.logInTransaction(tx, {
          performedBy: patientId,
          action: 'RECORDS_EXPORTED',
          targetUserId: patientId,
          entityType: 'records_exports',
          details: {
            via: 'app',
            timeZone,
            medicalFileEntryIds: record.medicalFile.map((entry) => entry.id),
            programIds: record.programs.map((program) => program.id),
            sessionIds: record.programs.flatMap((program) =>
              program.sessions.map((session) => session.id),
            ),
          },
        })

        return { pdf, fileName: exportFileName(record.madeAt, timeZone) }
      },
      { isolationLevel: 'repeatable read' },
    )
  }
}

// --- HELPERS -----------------------------------------------------------------------------------------------

// "stride-health-record-2026-10-26.pdf" — the day of the copy, in the
// patient's zone. 'en-CA' writes a date as YYYY-MM-DD: sortable in a
// Downloads folder, and the same shape on every machine.
export function exportFileName(madeAt: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(madeAt)
  return `stride-health-record-${day}.pdf`
}
