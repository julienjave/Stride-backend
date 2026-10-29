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

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common'
import {
  assertOwnPhoto,
  assertPhotoRoom,
  assertSamePhotos,
  extensionOfKey,
  NO_LIBRARY_PHOTOS_MESSAGE,
  PHOTO_LIMIT_MESSAGE,
  PROGRAM_EXERCISE_PHOTO_LIMIT,
  deletedPhotosDetail,
  programPhotoKey,
} from './program-photos'

// The pure rules of program-specific photos (decided 2026-10-17). The
// service applies them, and the e2e tests prove them through the API; here
// each rule's edges, one by one.

describe('the photo limit', () => {
  it('is 10 — the same number as the database CHECK (migration 0042)', () => {
    expect(PROGRAM_EXERCISE_PHOTO_LIMIT).toBe(10)
    expect(PHOTO_LIMIT_MESSAGE).toBe(
      'A program exercise can have at most 10 photos',
    )
  })

  // Up to the limit exactly: 8 + 2 and 0 + 10 both fit.
  it.each([
    [8, 2],
    [0, 10],
    [9, 1],
  ])('lets %i photos take %i more', (current, adding) => {
    expect(() => assertPhotoRoom(current, adding)).not.toThrow()
  })

  // One past it: a 409 saying how many more fit — including none.
  it.each([
    [8, 3, 'this one has 8, so 2 more can be added'],
    [10, 1, 'this one has 10, so no more can be added'],
    [0, 11, 'this one has 0, so 10 more can be added'],
  ])('refuses %i + %i, saying how many fit', (current, adding, tail) => {
    expect(() => assertPhotoRoom(current, adding)).toThrow(
      new ConflictException(
        `A program exercise can have at most 10 photos: ${tail}`,
      ),
    )
  })

  it('names the empty-library refusal', () => {
    expect(NO_LIBRARY_PHOTOS_MESSAGE).toBe(
      'This exercise has no photos in the library to copy',
    )
  })
})

describe('programPhotoKey', () => {
  // The patient's folder, a random UUID (v4: version digit 4), the
  // extension — nothing from the client's file name.
  it("names a file in the patient's folder, by a random UUID", () => {
    expect(programPhotoKey(5, 'png')).toMatch(
      /^patients\/5\/exercise-photos\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/,
    )
  })

  it('never names the same file twice', () => {
    expect(programPhotoKey(5, 'jpg')).not.toBe(programPhotoKey(5, 'jpg'))
  })
})

describe('extensionOfKey', () => {
  it.each([
    // A seeded library key (folder names hold underscores and digits).
    ['exercises/3_4_Sit-Up/0.jpg', 'jpg'],
    ['exercises/12/upload-1-0.webp', 'webp'],
    // Lower-cased: the copy's key follows the app's own style.
    ['exercises/9/Photo.PNG', 'png'],
    // Only the FILE name counts: a dot in a folder isn't an extension.
    ['exercises/v1.2/photo', 'bin'],
    ['photo', 'bin'],
  ])('%s → %s', (key, extension) => {
    expect(extensionOfKey(key)).toBe(extension)
  })
})

describe('assertSamePhotos', () => {
  const current = ['k/a.png', 'k/b.png', 'k/c.png']
  const refusal = new BadRequestException(
    "The new order must contain exactly this exercise's own photos, just reordered",
  )

  it('accepts the same photos in any order (the same order too)', () => {
    expect(() =>
      assertSamePhotos(current, ['k/c.png', 'k/a.png', 'k/b.png']),
    ).not.toThrow()
    expect(() => assertSamePhotos(current, [...current])).not.toThrow()
  })

  it.each([
    ['one missing (a removal is its own action)', ['k/a.png', 'k/b.png']],
    [
      'one added (a key never uploaded here)',
      [...current, 'patients/9/exercise-photos/x.png'],
    ],
    // The right length and every key known, but one twice — it would DROP
    // c.png from the list silently.
    ['one twice, padding the length', ['k/a.png', 'k/b.png', 'k/b.png']],
  ])('refuses %s', (_label, order) => {
    expect(() => assertSamePhotos(current, order)).toThrow(refusal)
  })
})

describe('assertOwnPhoto', () => {
  it("accepts one of the row's own photos", () => {
    expect(() =>
      assertOwnPhoto(['k/a.png', 'k/b.png'], 'k/b.png'),
    ).not.toThrow()
  })

  // A library photo, another row's or another patient's: not this row's.
  it('refuses any other key with a 404', () => {
    expect(() => assertOwnPhoto(['k/a.png'], 'exercises/5/0.jpg')).toThrow(
      new NotFoundException(
        "This photo is not one of this exercise's own photos",
      ),
    )
  })
})

// What an archive's audit entry says about the photos deleted with the
// program: the keys when there were some; NO key at all otherwise, so the
// entry of a program without own photos keeps its old shape.
describe('deletedPhotosDetail', () => {
  it('lists the keys when photos were deleted', () => {
    expect(deletedPhotosDetail(['patients/1/a.png'])).toStrictEqual({
      deletedOwnPhotos: ['patients/1/a.png'],
    })
  })

  it('adds nothing when there were none', () => {
    expect(deletedPhotosDetail([])).toStrictEqual({})
  })
})
