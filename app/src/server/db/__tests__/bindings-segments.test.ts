import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  getBindingsForIdentity,
  getSnapshotHistoryForIdentity,
  recordObservedBinding,
  recordResolvedBinding,
} from '../bindings'
import { createDb, type GroveDb } from '../client'
import { ecologySnapshots, repositories, repositoryBindings } from '../schema'
import { getPortfolioCalendarWindow } from '../snapshots'

let db: GroveDb

beforeEach(() => {
  db = createDb(new Database(':memory:'))
})

function seedSnapshot(fullName: string, observedAt: string) {
  db.insert(repositories)
    .values({
      fullName,
      htmlUrl: `https://github.com/${fullName}`,
      defaultBranch: 'main',
      lastObservedAt: observedAt,
    })
    .onConflictDoNothing()
    .run()
  db.insert(ecologySnapshots)
    .values({ fullName, observedAt, classified: true, phase: 'expanding' })
    .run()
}

describe('binding segments', () => {
  it('an identity returning to a former name gets a new segment, not one spanning the other identity', () => {
    // A holds the name, B takes it over, A gets it back.
    seedSnapshot('orchard/alpha', '2025-01-01T12:00:00.000Z') // A
    recordObservedBinding(100, 'orchard/alpha', '2025-01-01T12:00:00.000Z', db)
    seedSnapshot('orchard/alpha', '2025-02-01T12:00:00.000Z') // B
    recordObservedBinding(200, 'orchard/alpha', '2025-02-01T12:00:00.000Z', db)
    seedSnapshot('orchard/alpha', '2025-03-01T12:00:00.000Z') // A again
    recordObservedBinding(100, 'orchard/alpha', '2025-03-01T12:00:00.000Z', db)

    const segmentsA = getBindingsForIdentity(100, db)
    expect(segmentsA).toHaveLength(2)
    expect(segmentsA.map((b) => [b.firstObservedAt, b.lastObservedAt])).toEqual([
      ['2025-01-01T12:00:00.000Z', '2025-01-01T12:00:00.000Z'],
      ['2025-03-01T12:00:00.000Z', '2025-03-01T12:00:00.000Z'],
    ])
    expect(getSnapshotHistoryForIdentity(100, {}, db).map((r) => r.observedAt)).toEqual([
      '2025-03-01T12:00:00.000Z',
      '2025-01-01T12:00:00.000Z',
    ])
    expect(getSnapshotHistoryForIdentity(200, {}, db).map((r) => r.observedAt)).toEqual([
      '2025-02-01T12:00:00.000Z',
    ])
  })

  it('an identity returning to a former name starts a new segment even with no other holder in between', () => {
    seedSnapshot('orchard/alpha', '2025-01-01T12:00:00.000Z')
    recordObservedBinding(100, 'orchard/alpha', '2025-01-01T12:00:00.000Z', db)
    seedSnapshot('orchard/beta', '2025-02-01T12:00:00.000Z')
    recordObservedBinding(100, 'orchard/beta', '2025-02-01T12:00:00.000Z', db)
    seedSnapshot('orchard/alpha', '2025-03-01T12:00:00.000Z')
    recordObservedBinding(100, 'orchard/alpha', '2025-03-01T12:00:00.000Z', db)

    const segments = getBindingsForIdentity(100, db)
    expect(segments.map((b) => [b.fullName, b.firstObservedAt, b.lastObservedAt])).toEqual([
      ['orchard/alpha', '2025-01-01T12:00:00.000Z', '2025-01-01T12:00:00.000Z'],
      ['orchard/beta', '2025-02-01T12:00:00.000Z', '2025-02-01T12:00:00.000Z'],
      ['orchard/alpha', '2025-03-01T12:00:00.000Z', '2025-03-01T12:00:00.000Z'],
    ])
  })

  it('a continuing observation extends the current segment only', () => {
    seedSnapshot('orchard/alpha', '2025-01-01T12:00:00.000Z')
    recordObservedBinding(100, 'orchard/alpha', '2025-01-01T12:00:00.000Z', db)
    recordObservedBinding(100, 'orchard/alpha', '2025-01-03T12:00:00.000Z', db)
    expect(getBindingsForIdentity(100, db)).toHaveLength(1)
    expect(getBindingsForIdentity(100, db)[0].lastObservedAt).toBe(
      '2025-01-03T12:00:00.000Z',
    )
  })

  it('a resolved binding is recorded once per (id, name) without a unique index', () => {
    seedSnapshot('org-old/thing', '2024-11-01T12:00:00.000Z')
    const binding = {
      githubId: 100,
      fullName: 'org-old/thing',
      firstObservedAt: '2024-11-01T12:00:00.000Z',
      lastObservedAt: '2024-11-01T12:00:00.000Z',
      resolvedAt: '2025-01-01T00:00:00.000Z',
      evidence: {},
    }
    expect(recordResolvedBinding(binding, db)).toBe(true)
    expect(recordResolvedBinding(binding, db)).toBe(false)
    expect(db.select().from(repositoryBindings).all()).toHaveLength(1)
  })
})

describe('calendar windows never read past an identity’s bindings', () => {
  it('a reused name does not lend the previous identity’s rows to the new one', () => {
    // Old identity 100 observed on Jan 1–13; new identity 200 takes the name on Jan 14.
    for (let d = 1; d <= 13; d++) {
      seedSnapshot('orchard/alpha', `2025-01-${String(d).padStart(2, '0')}T12:00:00.000Z`)
    }
    recordObservedBinding(100, 'orchard/alpha', '2025-01-01T12:00:00.000Z', db)
    recordObservedBinding(100, 'orchard/alpha', '2025-01-13T12:00:00.000Z', db)
    recordObservedBinding(200, 'orchard/alpha', '2025-01-14T12:00:00.000Z', db)

    // Identity 200 has a binding but no rows inside it yet.
    const windows = getPortfolioCalendarWindow(
      [{ fullName: 'orchard/alpha', githubId: 200 }],
      '2025-01-14',
      14,
      db,
    )
    const observed = windows.get('orchard/alpha')!.filter((s) => s.snapshot !== undefined)
    expect(observed).toHaveLength(0)
  })

  it('a known identity with neither bindings nor rows of its own is not lent the name’s rows', () => {
    seedSnapshot('orchard/alpha', '2025-01-14T12:00:00.000Z')
    const windows = getPortfolioCalendarWindow(
      [{ fullName: 'orchard/alpha', githubId: 300 }],
      '2025-01-14',
      1,
      db,
    )
    expect(windows.get('orchard/alpha')?.[0].snapshot).toBeUndefined()
  })

  it('reads by the name only when no identity is known', () => {
    seedSnapshot('orchard/alpha', '2025-01-14T12:00:00.000Z')
    const windows = getPortfolioCalendarWindow([{ fullName: 'orchard/alpha' }], '2025-01-14', 1, db)
    expect(windows.get('orchard/alpha')?.[0].snapshot).toBeDefined()
  })
})
