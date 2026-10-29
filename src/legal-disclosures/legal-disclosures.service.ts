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
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { DRIZZLE, type DrizzleDb } from '../database/drizzle.provider'
import {
  legalDisclosureDetails,
  legalDisclosureOrders,
  legalDisclosures,
  userRoles,
  users,
  type LegalBasis,
} from '../database/schema'
import { applyUserContext, withRlsContext } from '../database/rls-context'
import { AuditService } from '../audit/audit.service'
import { UserRole } from '../users/dto/create-user.dto'
import {
  RecordsExportService,
  type RecordExport,
} from '../records-export/records-export.service'
import type { DisclosureStamp } from '../records-export/record-content'
import {
  dayOf,
  disclosureRequestRefusal,
  partFlags,
  partsFromFlags,
  type DisclosurePart,
} from './legal-disclosure-rules'
import type { MakeLegalDisclosureDto } from './dto/make-legal-disclosure.dto'

// --- TYPES -------------------------------------------------------------------------------------------------

export interface PersonRef {
  id: number
  firstName: string
  lastName: string
}

// What the PATIENT sees of a disclosure — their accounting (HIPAA
// 164.528(b)): who received it, why, when, what. Not the order's reference,
// the day it reached the clinic, nor who in the clinic made it (the person's
// choice: "who, why, when, what").
export interface OwnLegalDisclosure {
  id: number
  madeAt: Date
  recipientName: string
  recipientOrganisation: string | null
  legalBasis: LegalBasis
  basisExplanation: string | null
  parts: DisclosurePart[]
  periodFrom: string | null
  periodTo: string | null
}

// What an ADMIN sees: everything, the order and the hold included.
export interface LegalDisclosureSummary extends OwnLegalDisclosure {
  madeBy: PersonRef
  orderReference: string | null
  receivedOn: string
  // The moment the patient may see it (null: no hold) …
  withheldUntil: Date | null
  // … and whether they can now, by the DATABASE's clock — the one the
  // patient's own policy judges the hold by (0069), so the admin's page and
  // the patient's never disagree.
  shownToPatient: boolean
  withholdingStatement: string | null
}

// The signed-in user.
interface Actor {
  id: number
  activeRole: UserRole
}

// --- SERVICE -----------------------------------------------------------------------------------------------

// THE LEGAL DISCLOSURE (decisions §25, pass 3 — why it exists and why it is
// shaped this way is in legal-disclosures.schema.ts). In short: the law
// requires the clinic to hand a patient's record to someone outside it; an
// admin records the order — who receives it, under what, which parts, which
// period, a hold if an agency asked for one — and gets ONE PDF, stamped
// "Disclosed to … under … on …" on every page. The patient finds it in their
// accounting (My records, their own export) once any hold is over; the care
// team is told in "For review" (AlertsModule's LegalDisclosureNoticesService).
//
// The rule this file is careful about, as the complaint review's is: an
// admin never gains READ ACCESS to clinical tables. The copy is made by
// switching the transaction to the PATIENT's own row security
// (applyUserContext) and calling the generator the patient's own download
// uses — messages included, through the conversations the patient can read.
@Injectable()
export class LegalDisclosuresService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly recordsExportService: RecordsExportService,
    private readonly auditService: AuditService,
  ) {}

  // --- GET /users/:id/legal-disclosures ---

  // Every disclosure of this patient's record, newest first, with the
  // order's details — for admins.
  async list(
    patientId: number,
    actor: Actor,
  ): Promise<LegalDisclosureSummary[]> {
    await this.assertPatient(patientId)
    return this.findSummaries(actor, patientId)
  }

  // --- GET /legal-disclosures ---

  // The signed-in patient's accounting of disclosures, newest first. Read in
  // THEIR context: a disclosure still held back doesn't exist for them
  // (0069's policy) — the service filters nothing itself, so no screen can
  // show one early by mistake.
  async listOwn(patientId: number): Promise<OwnLegalDisclosure[]> {
    const rows = await withRlsContext(
      this.db,
      { id: patientId, activeRole: UserRole.PATIENT },
      (tx) =>
        tx
          .select({
            disclosure: legalDisclosures,
            details: legalDisclosureDetails,
          })
          .from(legalDisclosures)
          .innerJoin(
            legalDisclosureDetails,
            eq(legalDisclosureDetails.disclosureId, legalDisclosures.id),
          )
          .where(eq(legalDisclosures.patientId, patientId))
          .orderBy(desc(legalDisclosures.madeAt), desc(legalDisclosures.id)),
    )
    return rows.map(({ disclosure, details }) => ownView(disclosure, details))
  }

  // --- POST /users/:id/legal-disclosures ---

  // Records a disclosure AND makes its copy, in ONE transaction at
  // REPEATABLE READ (the export's "one moment"):
  //   1. as the ADMIN: the disclosure, its details and the order are written
  //      (all three or none — the policies require the same transaction),
  //      with LEGAL_DISCLOSURE_MADE;
  //   2. then as the PATIENT (applyUserContext): the record is read through
  //      the patient's own policies, narrowed to the order's parts and
  //      period, drawn, and recorded (RECORDS_EXPORTED, via legal_disclosure,
  //      with the ids of what went in) — before a byte leaves.
  // A failure anywhere rolls everything back: no disclosure is recorded
  // without its copy, and no copy leaves without its record.
  //
  // ONE copy per disclosure (decided with the person): the PDF is the
  // answer to this request, and no route makes it again. A second copy
  // would be a second disclosure, with its own record — what left the clinic
  // is then exactly what the list says.
  //
  // TWO audit entries, on purpose — the one exception to "one entry per
  // route", because they have different readers (decisions §16): the
  // disclosure itself (who to, under what — readable by admins in the audit
  // log) and the copy's contents (the ids of the patient's notes, sessions and
  // messages — clinical, withheld from admins like every RECORDS_EXPORTED).
  async make(
    patientId: number,
    dto: MakeLegalDisclosureDto,
    timeZone: string,
    actor: Actor,
  ): Promise<RecordExport> {
    await this.assertPatient(patientId)
    const request = {
      recipientName: dto.recipientName,
      recipientOrganisation: dto.recipientOrganisation ?? null,
      legalBasis: dto.legalBasis,
      basisExplanation: dto.basisExplanation ?? null,
      orderReference: dto.orderReference ?? null,
      receivedOn: dto.receivedOn,
      parts: partsFromFlags(partFlags(dto.parts)),
      periodFrom: dto.periodFrom ?? null,
      periodTo: dto.periodTo ?? null,
      withheldUntil: dto.withheldUntil ?? null,
      withholdingStatement: dto.withholdingStatement ?? null,
    }
    const refusal = disclosureRequestRefusal(
      request,
      dayOf(new Date(), timeZone),
    )
    if (refusal !== null) throw new BadRequestException(refusal)

    return withRlsContext(
      this.db,
      actor,
      async (tx) => {
        const [disclosure] = await tx
          .insert(legalDisclosures)
          .values({
            patientId,
            madeBy: actor.id,
            recipientName: request.recipientName,
            recipientOrganisation: request.recipientOrganisation,
            // The START of the chosen day in the admin's zone — computed by
            // Postgres from its own zone database: a day read as a
            // timestamp WITHOUT a zone, then placed in the zone (`AT TIME
            // ZONE` turns it into an instant). Node has no built-in way to
            // say "midnight in Montreal on that day"; Postgres does.
            withheldUntil:
              request.withheldUntil === null
                ? null
                : sql`(${request.withheldUntil}::date)::timestamp AT TIME ZONE ${timeZone}`,
          })
          // made_at is the trigger's: the database's now().
          .returning({
            id: legalDisclosures.id,
            madeAt: legalDisclosures.madeAt,
            withheldUntil: legalDisclosures.withheldUntil,
          })
        await tx.insert(legalDisclosureDetails).values({
          disclosureId: disclosure.id,
          legalBasis: request.legalBasis,
          basisExplanation: request.basisExplanation,
          ...partFlags(request.parts),
          periodFrom: request.periodFrom,
          periodTo: request.periodTo,
        })
        await tx.insert(legalDisclosureOrders).values({
          disclosureId: disclosure.id,
          orderReference: request.orderReference,
          receivedOn: request.receivedOn,
          withholdingStatement: request.withholdingStatement,
        })
        // The disclosure, complete: the audit log is read by admins only,
        // who see all of it on the patient's page anyway — and the trail must
        // say to whom and why a record left, even if a page changes.
        await this.auditService.logInTransaction(tx, {
          performedBy: actor.id,
          action: 'LEGAL_DISCLOSURE_MADE',
          targetUserId: patientId,
          entityType: 'legal_disclosures',
          entityId: disclosure.id,
          details: compact({
            recipientName: request.recipientName,
            recipientOrganisation: request.recipientOrganisation,
            legalBasis: request.legalBasis,
            basisExplanation: request.basisExplanation,
            orderReference: request.orderReference,
            receivedOn: request.receivedOn,
            parts: request.parts,
            periodFrom: request.periodFrom,
            periodTo: request.periodTo,
            withheldUntil: disclosure.withheldUntil,
            withholdingStatement: request.withholdingStatement,
          }),
        })

        // The admin's name for the stamp — users is readable by every
        // session (0007), so read it before the switch, as the admin.
        const [admin] = await tx
          .select({ firstName: users.firstName, lastName: users.lastName })
          .from(users)
          .where(eq(users.id, actor.id))
        const stamp: DisclosureStamp = {
          disclosureId: disclosure.id,
          madeBy: `${admin.firstName} ${admin.lastName}`,
          recipientName: request.recipientName,
          recipientOrganisation: request.recipientOrganisation,
          legalBasis: request.legalBasis,
          basisExplanation: request.basisExplanation,
          orderReference: request.orderReference,
          receivedOn: request.receivedOn,
          parts: request.parts,
          period: { from: request.periodFrom, to: request.periodTo },
        }

        // From here the transaction acts AS THE PATIENT: no admin branch on
        // any clinical table is used, or needed (decisions §16 holds).
        await applyUserContext(tx, {
          id: patientId,
          activeRole: UserRole.PATIENT,
        })
        return this.recordsExportService.exportInTransaction(
          tx,
          patientId,
          timeZone,
          { via: 'legal_disclosure', adminId: actor.id, stamp },
        )
      },
      { isolationLevel: 'repeatable read' },
    )
  }

  // === PRIVATE ============================================================

  // 404 when there is no such account, 400 when it isn't a patient's — the
  // complaint review's checks (users and user_roles are readable without a
  // session context: 0007, 0009).
  private async assertPatient(patientId: number): Promise<void> {
    const [account] = await this.db
      .select({ id: users.id })
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
        'Only a patient has a health record to disclose',
      )
    }
  }

  // One patient's disclosures as an admin sees them, newest first: the three
  // tables joined (an admin reads all three — 0069), the hold judged by the
  // database's clock, names read in one batched query.
  private async findSummaries(
    actor: Actor,
    patientId: number,
  ): Promise<LegalDisclosureSummary[]> {
    const rows = await withRlsContext(this.db, actor, (tx) =>
      tx
        .select({
          disclosure: legalDisclosures,
          details: legalDisclosureDetails,
          order: legalDisclosureOrders,
          shownToPatient: sql<boolean>`(${legalDisclosures.withheldUntil} IS NULL OR ${legalDisclosures.withheldUntil} <= now())`,
        })
        .from(legalDisclosures)
        .innerJoin(
          legalDisclosureDetails,
          eq(legalDisclosureDetails.disclosureId, legalDisclosures.id),
        )
        .innerJoin(
          legalDisclosureOrders,
          eq(legalDisclosureOrders.disclosureId, legalDisclosures.id),
        )
        .where(eq(legalDisclosures.patientId, patientId))
        // Newest first; two in the same instant (two admins) are possible,
        // so the id breaks the tie: a stable order.
        .orderBy(desc(legalDisclosures.madeAt), desc(legalDisclosures.id)),
    )
    if (rows.length === 0) return []

    const ids = [...new Set(rows.map(({ disclosure }) => disclosure.madeBy))]
    const people = await this.db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(users)
      .where(inArray(users.id, ids))
    const byId = new Map(people.map((person) => [person.id, person]))

    return rows.map(({ disclosure, details, order, shownToPatient }) => ({
      ...ownView(disclosure, details),
      madeBy: byId.get(disclosure.madeBy)!,
      orderReference: order.orderReference,
      receivedOn: order.receivedOn,
      withheldUntil: disclosure.withheldUntil,
      shownToPatient,
      withholdingStatement: order.withholdingStatement,
    }))
  }
}

// --- HELPERS -----------------------------------------------------------------------------------------------

// The fields every reader of a disclosure may see — the patient's view, and
// the start of the admin's.
function ownView(
  disclosure: typeof legalDisclosures.$inferSelect,
  details: typeof legalDisclosureDetails.$inferSelect,
): OwnLegalDisclosure {
  return {
    id: disclosure.id,
    madeAt: disclosure.madeAt,
    recipientName: disclosure.recipientName,
    recipientOrganisation: disclosure.recipientOrganisation,
    legalBasis: details.legalBasis,
    basisExplanation: details.basisExplanation,
    parts: partsFromFlags(details),
    periodFrom: details.periodFrom,
    periodTo: details.periodTo,
  }
}

// An audit entry's details without the keys whose value is null — an
// optional field not given is simply absent from the entry, as in the
// complaint review's (`...(caseReference === null ? {} : { caseReference })`).
function compact(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== null),
  )
}
