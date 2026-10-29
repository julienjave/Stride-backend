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

import {
  deleteAllUnreferenced,
  storeAll,
  undoStoredOnFailure,
} from './compensation'

// The undo logic on its own, with a fake storage that records every call in
// one list — so a test can say not only WHAT was deleted but WHEN, relative
// to the puts. (Each service's wiring is proven end to end:
// test/storage-cleanup.e2e-spec.ts and test/program-exercise-photos.e2e-spec.ts.)
describe('storage compensation', () => {
  let events: string[]
  let storage: { deleteUnreferenced: jest.Mock<Promise<void>, [string]> }

  beforeEach(() => {
    events = []
    storage = {
      deleteUnreferenced: jest.fn((key: string) => {
        events.push(`delete ${key}`)
        return Promise.resolve()
      }),
    }
  })

  // A file to store whose put records itself, and fails when told to.
  function file(key: string, fails = false) {
    return {
      key,
      put: jest.fn((givenKey: string) => {
        events.push(`put ${givenKey}`)
        return fails
          ? Promise.reject(new Error(`storage refused ${givenKey}`))
          : Promise.resolve()
      }),
    }
  }

  describe('storeAll', () => {
    it('puts each file at its key, one after the other, and returns the keys in order', async () => {
      const keys = await storeAll(storage, [file('a'), file('b'), file('c')])

      expect(keys).toEqual(['a', 'b', 'c'])
      expect(events).toEqual(['put a', 'put b', 'put c'])
    })

    // One at a time: the 3rd is never tried once the 2nd failed, and only
    // the 1st — the one really stored — is deleted. The SAME error goes on.
    it('when one fails, deletes the ones already stored, tries no more, and rethrows that error', async () => {
      const third = file('c')

      await expect(
        storeAll(storage, [file('a'), file('b', true), third]),
      ).rejects.toThrow(new Error('storage refused b'))

      expect(events).toEqual(['put a', 'put b', 'delete a'])
      expect(third.put).not.toHaveBeenCalled()
    })

    it('deletes nothing when the first one fails', async () => {
      await expect(storeAll(storage, [file('a', true)])).rejects.toThrow(
        'storage refused a',
      )
      expect(storage.deleteUnreferenced).not.toHaveBeenCalled()
    })

    it('stores nothing for an empty list', async () => {
      expect(await storeAll(storage, [])).toEqual([])
      expect(events).toEqual([])
    })
  })

  describe('undoStoredOnFailure', () => {
    it("returns the work's result and deletes nothing when it succeeds", async () => {
      const result = await undoStoredOnFailure(storage, ['a', 'b'], () =>
        Promise.resolve('saved'),
      )

      expect(result).toBe('saved')
      expect(storage.deleteUnreferenced).not.toHaveBeenCalled()
    })

    // The deletes come AFTER the work failed, and BEFORE the error reaches
    // the caller: by the time the request answers, the files are gone.
    it('deletes every key when the work fails, then rethrows the same error', async () => {
      const error = new Error('the transaction was refused')
      let deletedBeforeCallerSawIt: string[] = []

      await undoStoredOnFailure(storage, ['a', 'b'], () => {
        events.push('work')
        return Promise.reject(error)
      }).catch((caught: unknown) => {
        expect(caught).toBe(error)
        deletedBeforeCallerSawIt = [...events]
      })

      expect(deletedBeforeCallerSawIt).toEqual(['work', 'delete a', 'delete b'])
    })
  })

  describe('deleteAllUnreferenced', () => {
    it('asks for each key to be deleted', async () => {
      await deleteAllUnreferenced(storage, ['a', 'b'])
      expect(storage.deleteUnreferenced.mock.calls).toEqual([['a'], ['b']])
    })
  })
})
