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

import type { StorageService } from './storage.service'

// --- WHY THIS FILE -----------------------------------------------------------------------------------------

// Storage is NOT part of a database transaction. When a request uploads a
// file and then saves its key on a row, a failure of the save rolls the row
// back — but the file is already in storage, and nothing will ever point at
// it. The fix is a COMPENSATING ACTION: the code that did the side effect
// undoes it itself when the step after it fails (the "saga" idea, in
// miniature: every step that can't be rolled back has an explicit undo).
//
// Three helpers, used by every upload in the app (library photos, a program
// exercise's own photos, avatars, clinic logos) — written once here so
// "what an undo means" is decided in one place:
//   - storeAll: put several files, one at a time; if one fails, delete the
//     ones already stored, then let the error go on.
//   - undoStoredOnFailure: run the database work that will point rows at
//     the stored keys; if it fails, delete those files, then let the error
//     go on.
//   - deleteAllUnreferenced: the best-effort delete of several files, in
//     parallel (StorageService.deleteUnreferenced never throws; it logs).
//
// Plain functions taking the storage as a parameter, not StorageService
// methods: the services' unit specs replace StorageService with a small
// object of jest.fn()s — had these been methods, the specs would replace
// them too, and the undo logic would never run in any service's tests.
// Taking only `deleteUnreferenced` (a Pick) keeps that fake object small.

type Remover = Pick<StorageService, 'deleteUnreferenced'>

// One file to store: the key it will live at, and how to put it there — an
// upload or a copy; the caller decides (the helpers don't care which).
export interface FileToStore {
  key: string
  put: (key: string) => Promise<unknown>
}

// --- HELPERS -----------------------------------------------------------------------------------------------

// Best-effort deletion of files nothing points at (any more, or ever).
// In parallel: the deletes don't depend on each other, and each one already
// swallows its own failure (it logs the key — the storage sweeper,
// scripts/storage-sweep.ts, collects what is left).
export async function deleteAllUnreferenced(
  storage: Remover,
  keys: readonly string[],
): Promise<void> {
  await Promise.all(keys.map((key) => storage.deleteUnreferenced(key)))
}

// Stores the files ONE AT A TIME, in order, and returns their keys. If one
// fails, the files stored before it are deleted (nothing points at them
// yet, and nothing ever will), then the error goes on to the caller.
// One at a time rather than all at once (Promise.all): at most a handful of
// files, and a failure stops the rest instead of racing them — with
// Promise.all, files still uploading when another failed would land AFTER
// the undo ran, and be orphaned anyway.
export async function storeAll(
  storage: Remover,
  files: readonly FileToStore[],
): Promise<string[]> {
  const stored: string[] = []
  try {
    for (const file of files) {
      await file.put(file.key)
      stored.push(file.key)
    }
  } catch (error) {
    await deleteAllUnreferenced(storage, stored)
    throw error
  }
  return stored
}

// Runs `work` — the transaction that will point rows at `keys` — and, if it
// fails, deletes the files at `keys` before the error goes on: the rollback
// left nothing pointing at them. When the work succeeds nothing is deleted:
// the rows now reference the files.
//
// One honest limit: if the connection drops DURING the commit itself, the
// driver reports an error without knowing whether the commit happened.
// Deleting then could leave a saved row pointing at a missing file (a broken
// image). That is rare enough to accept — the alternative, never undoing,
// leaves a file behind on EVERY failure.
export async function undoStoredOnFailure<T>(
  storage: Remover,
  keys: readonly string[],
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work()
  } catch (error) {
    await deleteAllUnreferenced(storage, keys)
    throw error
  }
}
