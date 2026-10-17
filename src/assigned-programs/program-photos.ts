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

import { randomUUID } from 'node:crypto'
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common'

// --- PROGRAM-SPECIFIC PHOTOS: THE RULES ---------------------------------------------------------------------
//
// Decided with the person, 2026-10-17 (decisions §5, "Program-specific
// photos"). Per program exercise, the practitioner chooses between the
// LIBRARY's photos (read live — the default) and photos of THIS row's own
// (`use_library_images` / `media_urls`): uploaded for this patient, or
// copied from the library. The rules that need no database live here, as
// pure functions — each one testable on its own, with no Nest module, no
// storage and no SQL — and AssignedProgramsService calls them.

// At most 10 own photos per program exercise. The library's per-request
// cap is 5 (FilesInterceptor), with no total cap at all; a program exercise
// gets a total, because each photo here may show the patient (health data
// worth keeping to what is needed) and every one is signed into every
// answer about the program. The database's CHECK
// (assigned_program_exercises_photo_limit) holds the same number.
export const PROGRAM_EXERCISE_PHOTO_LIMIT = 10

// The refusal when a request would go past the limit. A 409 (Conflict), not
// a 400: the request itself is well-formed — 3 photos is a fine upload — it's
// the row's CURRENT state (8 photos already) that refuses it. It says how
// many more fit, so the practitioner knows what to do; nothing is added
// partially (copying "the first 2 of 3" would be a surprise).
export function assertPhotoRoom(current: number, adding: number) {
  if (current + adding > PROGRAM_EXERCISE_PHOTO_LIMIT) {
    // Never negative: `current` is at most 10 (the database's CHECK).
    const room = PROGRAM_EXERCISE_PHOTO_LIMIT - current
    throw new ConflictException(
      `A program exercise can have at most ${PROGRAM_EXERCISE_PHOTO_LIMIT} photos: this one has ${current}, so ${room === 0 ? 'no more can' : `${room} more can`} be added`,
    )
  }
}

// The database CHECK's refusal, translated by HttpExceptionFilter. It knows
// no counts (a constraint only says "refused"), hence the shorter wording.
export const PHOTO_LIMIT_MESSAGE = `A program exercise can have at most ${PROGRAM_EXERCISE_PHOTO_LIMIT} photos`

// "Add the library's photos" on an exercise whose library entry has none:
// nothing to copy. A 409 for the same reason as the limit — the request is
// fine, the library's current state can't satisfy it.
export const NO_LIBRARY_PHOTOS_MESSAGE =
  'This exercise has no photos in the library to copy'

// Where an own photo is stored. Grouped by PATIENT, not by program or row:
//   - the key must exist BEFORE the database rows do — "Assign again"
//     copies the files first, outside the transaction (a network call
//     doesn't belong inside one: it would hold the transaction's locks while
//     waiting on storage), and the new program's and rows' ids don't exist
//     yet at that point. The patient's id does.
//   - the patient is the unit that matters for privacy: "everything stored
//     about this patient" is one prefix to list (an export, an erasure).
// A random UUID names the file: unguessable, and never the client's own
// file name (which could say anything — or name the patient).
export function programPhotoKey(patientId: number, extension: string) {
  return `patients/${patientId}/exercise-photos/${randomUUID()}.${extension}`
}

// The extension of an existing key, for a COPY's new key — the copy is the
// same file, so the same type. Lower-cased; 'bin' when there is none, the
// same fallback as extensionForMimeType (image-upload.config.ts). Only the
// FILE name can match: the pattern is a dot, then letters and digits up to
// the END of the key — a "/" can't be among them, so a dot in a folder name
// ("v1.2/photo") never counts.
export function extensionOfKey(key: string) {
  const match = /\.([A-Za-z0-9]+)$/.exec(key)
  return match ? match[1].toLowerCase() : 'bin'
}

// A reorder must be the SAME photos in another order — no key added (a key
// that was never uploaded here, maybe another patient's), none dropped (a
// removal is its own action, with its own audit entry), none twice. The same
// three checks as the library's reorderImages: length, no duplicates,
// membership.
export function assertSamePhotos(current: string[], order: string[]) {
  const currentSet = new Set(current)
  const isPermutation =
    order.length === current.length &&
    new Set(order).size === order.length &&
    order.every((key) => currentSet.has(key))
  if (!isPermutation) {
    throw new BadRequestException(
      "The new order must contain exactly this exercise's own photos, just reordered",
    )
  }
}

// A removal must name one of THIS row's own photos — a library photo, or
// another row's, is not this row's to delete. 404: from the request's point
// of view, that photo doesn't exist here.
export function assertOwnPhoto(current: string[], objectKey: string) {
  if (!current.includes(objectKey)) {
    throw new NotFoundException(
      "This photo is not one of this exercise's own photos",
    )
  }
}
