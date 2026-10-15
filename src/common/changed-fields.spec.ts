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

import { changedFields } from './changed-fields'

describe('changedFields', () => {
  it('lists a changed field with its value before and after', () => {
    expect(changedFields({ sets: 3, reps: 10 }, { sets: 4 })).toStrictEqual({
      sets: { from: 3, to: 4 },
    })
  })

  it('leaves out a field re-sent with the value it already had', () => {
    expect(changedFields({ sets: 3 }, { sets: 3 })).toStrictEqual({})
  })

  it('leaves out a field not sent (undefined), and keeps a cleared one (null)', () => {
    expect(
      changedFields({ sets: 3, notes: 'x' }, { sets: undefined, notes: null }),
    ).toStrictEqual({ notes: { from: 'x', to: null } })
  })

  it('compares arrays by their items, not by identity', () => {
    expect(changedFields({ m: ['legs'] }, { m: ['legs'] })).toStrictEqual({})
    expect(changedFields({ m: ['legs'] }, { m: ['arms'] })).toStrictEqual({
      m: { from: ['legs'], to: ['arms'] },
    })
    expect(
      changedFields({ m: ['legs'] }, { m: ['legs', 'arms'] }),
    ).toStrictEqual({ m: { from: ['legs'], to: ['legs', 'arms'] } })
  })
})
