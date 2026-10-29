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

import { is } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import * as schema from '../../src/database/schema'
import type { StoredObject } from '../../src/storage/storage.service'
import {
  DEFAULT_MIN_AGE_HOURS,
  parseSweepArgs,
  planSweep,
  REFERENCE_COLUMNS,
  REFERENCED_KEYS_SQL,
  refuseSweep,
  runSweep,
  sweepReport,
  SWEPT_PREFIXES,
} from './sweep'

// The sweeper's rules with plain values. Its real database query and a real
// S3 server: test/storage-sweep.e2e-spec.ts.

const HOUR = 60 * 60 * 1000
const NOW = new Date('2031-03-10T12:00:00Z')
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * HOUR)
const object = (key: string, ageHours: number, size = 100): StoredObject => ({
  key,
  lastModified: hoursAgo(ageHours),
  size,
})

describe('parseSweepArgs', () => {
  it('is a dry run with the default minimum age when given nothing', () => {
    expect(parseSweepArgs([])).toStrictEqual({
      delete: false,
      minAgeHours: DEFAULT_MIN_AGE_HOURS,
    })
    expect(DEFAULT_MIN_AGE_HOURS).toBe(24)
  })

  it('reads --delete and --min-age-hours=N', () => {
    expect(parseSweepArgs(['--min-age-hours=48', '--delete'])).toStrictEqual({
      delete: true,
      minAgeHours: 48,
    })
    expect(parseSweepArgs(['--min-age-hours=1']).minAgeHours).toBe(1)
  })

  // 0 would remove the guard against an upload whose row isn't saved yet.
  it('refuses a minimum age under 1 hour', () => {
    expect(() => parseSweepArgs(['--min-age-hours=0'])).toThrow(
      new Error(
        '--min-age-hours must be at least 1: a younger file may belong to an upload whose row is not saved yet.',
      ),
    )
  })

  // A typo must not quietly become a dry run — nor a half-read number.
  it.each(['--delet', '--min-age-hours=1.5', '--min-age-hours', 'delete'])(
    'refuses "%s"',
    (arg) => {
      expect(() => parseSweepArgs([arg])).toThrow(
        new Error(
          `Unknown argument "${arg}". Use --delete to delete (without it, nothing is deleted) and --min-age-hours=N (default 24).`,
        ),
      )
    },
  )
})

describe('refuseSweep', () => {
  it('refuses a database whose name ends in _test, saying why', () => {
    expect(refuseSweep('stride_test')).toBe(
      'Refusing to sweep with "stride_test": databases ending in _test belong to the e2e tests, and their files share the bucket with the development database\'s — sweeping with the test database\'s references would delete the development files. Sweep with the development database (POSTGRES_DB in .env).',
    )
  })

  it('accepts any other name', () => {
    expect(refuseSweep('stride')).toBeNull()
    expect(refuseSweep('stride_testing_copy')).toBeNull()
  })
})

describe('planSweep', () => {
  // Each object in exactly one group; the age boundary is "at least the
  // minimum age" — exactly 24 hours old is old enough.
  it('sorts objects into referenced, too recent and orphans', () => {
    const plan = planSweep(
      [
        object('avatars/1/used.png', 100),
        object('avatars/1/new.png', 23.99),
        object('avatars/1/exactly.png', 24),
        object('avatars/1/old.png', 500),
        // Referenced AND recent: it's in use — counted as such.
        object('clinics/1/fresh-logo.png', 0.1),
      ],
      new Set(['avatars/1/used.png', 'clinics/1/fresh-logo.png']),
      NOW,
      24 * HOUR,
    )

    expect(plan).toStrictEqual({
      referenced: 2,
      tooRecent: [object('avatars/1/new.png', 23.99)],
      orphans: [
        object('avatars/1/exactly.png', 24),
        object('avatars/1/old.png', 500),
      ],
    })
  })
})

// The list of columns holding keys must follow the schema: a new
// `…_path` / `media_urls` column left out would have its files deleted.
describe('REFERENCE_COLUMNS', () => {
  const tables = Object.values(schema).filter((value) => is(value, PgTable))
  const keyColumns = tables.flatMap((table) => {
    const config = getTableConfig(table)
    return config.columns
      .filter(
        (column) =>
          column.name.endsWith('_path') || column.name === 'media_urls',
      )
      .map((column) => ({
        table: config.name,
        column: column.name,
        array: column.columnType === 'PgArray',
      }))
  })

  it('lists every column of the schema that holds storage keys — and only those', () => {
    const sort = (list: { table: string; column: string }[]) =>
      [...list].sort((a, b) =>
        `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`),
      )
    expect(sort([...REFERENCE_COLUMNS])).toEqual(sort(keyColumns))
  })

  it('builds one query from them, each key once', () => {
    expect(REFERENCED_KEYS_SQL).toBe(
      [
        'SELECT avatar_path AS key FROM users WHERE avatar_path IS NOT NULL',
        'SELECT logo_path AS key FROM clinics WHERE logo_path IS NOT NULL',
        'SELECT unnest(media_urls) AS key FROM exercises',
        'SELECT unnest(media_urls) AS key FROM assigned_program_exercises',
      ].join('\nUNION\n'),
    )
  })

  it('sweeps the four folders the app writes into', () => {
    expect(SWEPT_PREFIXES).toEqual([
      'avatars/',
      'clinics/',
      'exercises/',
      'patients/',
    ])
  })
})

describe('runSweep', () => {
  let events: string[]
  let stored: Record<string, StoredObject[]>
  let failing: Set<string>

  beforeEach(() => {
    events = []
    stored = {
      'avatars/': [
        object('avatars/1/used.png', 100),
        object('avatars/1/old.png', 100),
      ],
      'clinics/': [
        object('clinics/1/old.png', 100),
        object('clinics/1/new.png', 1),
      ],
    }
    failing = new Set()
  })

  function dependencies() {
    return {
      storage: {
        // An async generator like the real one; records when it is read.
        async *listObjects(prefix: string) {
          events.push(`list ${prefix}`)
          for (const entry of stored[prefix] ?? []) {
            await Promise.resolve()
            yield entry
          }
        },
        delete: jest.fn((key: string) => {
          events.push(`delete ${key}`)
          return failing.has(key)
            ? Promise.reject(new Error('Access Denied'))
            : Promise.resolve()
        }),
      },
      readReferencedKeys: jest.fn(() => {
        events.push('read references')
        return Promise.resolve(new Set(['avatars/1/used.png']))
      }),
      now: () => NOW,
    }
  }

  // Storage is listed BEFORE the database is read: a key saved on a row at
  // any moment before the read is then seen as used.
  it('lists storage first, then reads the references — and a dry run deletes nothing', async () => {
    const deps = dependencies()
    const result = await runSweep(deps, {
      prefixes: ['avatars/', 'clinics/'],
      minAgeHours: 24,
      delete: false,
    })

    expect(events).toEqual([
      'list avatars/',
      'list clinics/',
      'read references',
    ])
    expect(result).toStrictEqual({
      plan: {
        referenced: 1,
        tooRecent: [object('clinics/1/new.png', 1)],
        orphans: [
          object('avatars/1/old.png', 100),
          object('clinics/1/old.png', 100),
        ],
      },
      deleted: [],
      failed: [],
    })
  })

  it('lists only the prefixes it is given', async () => {
    await runSweep(dependencies(), {
      prefixes: ['clinics/'],
      minAgeHours: 24,
      delete: false,
    })
    expect(events).toEqual(['list clinics/', 'read references'])
  })

  it('uses the minimum age it is given', async () => {
    const result = await runSweep(dependencies(), {
      prefixes: ['clinics/'],
      minAgeHours: 1,
      delete: false,
    })
    expect(result.plan.orphans.map((o) => o.key)).toEqual([
      'clinics/1/old.png',
      'clinics/1/new.png',
    ])
  })

  // One failure doesn't stop the others; each is reported.
  it('with delete, deletes each orphan in turn, noting the ones that fail', async () => {
    failing.add('avatars/1/old.png')
    const deps = dependencies()

    const result = await runSweep(deps, {
      prefixes: ['avatars/', 'clinics/'],
      minAgeHours: 24,
      delete: true,
    })

    expect(events.slice(3)).toEqual([
      'delete avatars/1/old.png',
      'delete clinics/1/old.png',
    ])
    expect(result.deleted).toEqual(['clinics/1/old.png'])
    expect(result.failed).toEqual([
      { key: 'avatars/1/old.png', reason: 'Access Denied' },
    ])
  })
})

describe('sweepReport', () => {
  const plan = {
    referenced: 3,
    tooRecent: [object('avatars/1/new.png', 1)],
    orphans: [object('avatars/1/old.png', 48, 2048)],
  }

  it('lists the orphans with their size and date in a dry run', () => {
    expect(
      sweepReport(
        { plan, deleted: [], failed: [] },
        { delete: false, minAgeHours: 24 },
      ),
    ).toEqual([
      'Listed 5 file(s): 3 in use, 1 not in use but younger than 24 hour(s) (left alone), 1 not in use.',
      'Not in use (dry run — nothing deleted; add --delete):',
      '  avatars/1/old.png  (2048 bytes, written 2031-03-08T12:00:00.000Z)',
    ])
  })

  it('lists what was deleted, and what could not be', () => {
    expect(
      sweepReport(
        {
          plan: { ...plan, orphans: [...plan.orphans, object('b', 50)] },
          deleted: ['avatars/1/old.png'],
          failed: [{ key: 'b', reason: 'Access Denied' }],
        },
        { delete: true, minAgeHours: 24 },
      ),
    ).toEqual([
      'Listed 6 file(s): 3 in use, 1 not in use but younger than 24 hour(s) (left alone), 2 not in use.',
      'Deleted 1 file(s):',
      '  avatars/1/old.png',
      'Could not delete 1 file(s):',
      '  b: Access Denied',
    ])
  })

  // Nothing listed as "could not" when everything went.
  it('says nothing about failures when there were none', () => {
    expect(
      sweepReport(
        { plan, deleted: ['avatars/1/old.png'], failed: [] },
        { delete: true, minAgeHours: 24 },
      ),
    ).toEqual([
      'Listed 5 file(s): 3 in use, 1 not in use but younger than 24 hour(s) (left alone), 1 not in use.',
      'Deleted 1 file(s):',
      '  avatars/1/old.png',
    ])
  })

  it('says so when there is nothing to delete', () => {
    expect(
      sweepReport(
        { plan: { ...plan, orphans: [] }, deleted: [], failed: [] },
        { delete: true, minAgeHours: 24 },
      ),
    ).toEqual([
      'Listed 4 file(s): 3 in use, 1 not in use but younger than 24 hour(s) (left alone), 0 not in use.',
      'Nothing to delete.',
    ])
  })
})