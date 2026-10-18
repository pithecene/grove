import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  getBindingsForIdentity,
  getDeclarationHistoryForIdentity,
  getIdentityForName,
  getObservedSpanForName,
  getSnapshotHistoryForIdentity,
  listUnboundNames,
  recordObservedBinding,
  recordResolvedBinding,
} from '../bindings'
import { createDb, type GroveDb } from '../client'
import { declarationChanges, ecologySnapshots, repositories } from '../schema'
import { getPortfolioCalendarWindow, upsertRepositories } from '../snapshots'

let db: GroveDb

beforeEach(() => {
  db = createDb(new Database(':memory:'))
})

function seedRepo(fullName: string) {
  db.insert(repositories)
    .values({
      fullName,
      htmlUrl: `https://github.com/${fullName}`,
      defaultBranch: 'main',
      lastObservedAt: '2025-01-01T00:00:00.000Z',
    })
    .onConflictDoNothing()
    .run()
}

function seedSnapshot(fullName: string, observedAt: string, phase = 'expanding') {
  seedRepo(fullName)
  db.insert(ecologySnapshots)
    .values({ fullName, observedAt, classified: true, phase, densityTier: 'rooting' })
    .run()
}

function seedDeclaration(fullName: string, observedAt: string, phase: string) {
  seedRepo(fullName)
  db.insert(declarationChanges)
    .values({ fullName, observedAt, classified: true, intent: 'synthetic', phase })
    .run()
}

describe('recordObservedBinding', () => {
  it('inserts on first observation and extends bounds on later ones', () => {
    seedRepo('orchard/alpha')
    recordObservedBinding(100, 'orchard/alpha', '2025-01-05T10:00:00.000Z', db)
    recordObservedBinding(100, 'orchard/alpha', '2025-01-07T10:00:00.000Z', db)
    recordObservedBinding(100, 'orchard/alpha', '2025-01-03T10:00:00.000Z', db)

    const bindings = getBindingsForIdentity(100, db)
    expect(bindings).toHaveLength(1)
    expect(bindings[0].firstObservedAt).toBe('2025-01-03T10:00:00.000Z')
    expect(bindings[0].lastObservedAt).toBe('2025-01-07T10:00:00.000Z')
    expect(bindings[0].method).toBe('observed')
  })

  it('a name observed under a different id gets its own binding (name reuse)', () => {
    seedRepo('orchard/alpha')
    recordObservedBinding(100, 'orchard/alpha', '2025-01-05T10:00:00.000Z', db)
    recordObservedBinding(200, 'orchard/alpha', '2025-02-01T10:00:00.000Z', db)

    expect(getBindingsForIdentity(100, db)).toHaveLength(1)
    expect(getBindingsForIdentity(200, db)).toHaveLength(1)
    expect(getIdentityForName('orchard/alpha', db)).toBe(200)
  })

  it('upsertRepositories records the binding when an id is known', () => {
    upsertRepositories(
      [
        {
          fullName: 'orchard/alpha',
          htmlUrl: 'https://github.com/orchard/alpha',
          defaultBranch: 'main',
          githubId: 100,
        },
      ],
      db,
    )
    expect(getIdentityForName('orchard/alpha', db)).toBe(100)
    expect(listUnboundNames(db)).toEqual([])
  })
})

describe('recordResolvedBinding', () => {
  it('inserts once and never overwrites an existing binding', () => {
    seedRepo('orchard/old-name')
    const first = recordResolvedBinding(
      {
        githubId: 100,
        fullName: 'orchard/old-name',
        firstObservedAt: '2024-11-01T00:00:00.000Z',
        lastObservedAt: '2024-12-01T00:00:00.000Z',
        resolvedAt: '2025-01-10T00:00:00.000Z',
        evidence: { resolved_full_name: 'orchard/alpha' },
      },
      db,
    )
    const second = recordResolvedBinding(
      {
        githubId: 100,
        fullName: 'orchard/old-name',
        firstObservedAt: '2000-01-01T00:00:00.000Z',
        lastObservedAt: '2030-01-01T00:00:00.000Z',
        resolvedAt: '2025-02-10T00:00:00.000Z',
        evidence: { resolved_full_name: 'orchard/alpha' },
      },
      db,
    )
    expect(first).toBe(true)
    expect(second).toBe(false)
    const binding = getBindingsForIdentity(100, db)[0]
    expect(binding.resolvedAt).toBe('2025-01-10T00:00:00.000Z')
    expect(binding.firstObservedAt).toBe('2024-11-01T00:00:00.000Z')
    expect(JSON.parse(binding.evidence ?? '{}')).toEqual({
      resolved_full_name: 'orchard/alpha',
    })
  })
})

describe('history across bindings', () => {
  it('follows a rename chain and leaves original rows untouched', () => {
    // one identity, three names over time
    seedSnapshot('person/thing', '2024-10-01T12:00:00.000Z')
    seedSnapshot('person/thing', '2024-10-02T12:00:00.000Z')
    seedSnapshot('org-old/thing', '2024-11-01T12:00:00.000Z')
    seedSnapshot('org/thing', '2025-01-01T12:00:00.000Z')

    recordResolvedBinding(
      {
        githubId: 100,
        fullName: 'person/thing',
        firstObservedAt: '2024-10-01T12:00:00.000Z',
        lastObservedAt: '2024-10-02T12:00:00.000Z',
        resolvedAt: '2025-01-01T00:00:00.000Z',
        evidence: {},
      },
      db,
    )
    recordResolvedBinding(
      {
        githubId: 100,
        fullName: 'org-old/thing',
        firstObservedAt: '2024-11-01T12:00:00.000Z',
        lastObservedAt: '2024-11-01T12:00:00.000Z',
        resolvedAt: '2025-01-01T00:00:00.000Z',
        evidence: {},
      },
      db,
    )
    recordObservedBinding(100, 'org/thing', '2025-01-01T12:00:00.000Z', db)

    const history = getSnapshotHistoryForIdentity(100, {}, db)
    expect(history.map((r) => r.fullName)).toEqual([
      'org/thing',
      'org-old/thing',
      'person/thing',
      'person/thing',
    ])
    // original rows still keyed by the names they were observed under
    const raw = db.select().from(ecologySnapshots).all()
    expect(raw.filter((r) => r.fullName === 'person/thing')).toHaveLength(2)
  })

  it('attributes a reused name to the right identity by time', () => {
    seedSnapshot('orchard/alpha', '2024-06-01T12:00:00.000Z') // belonged to id 100
    seedSnapshot('orchard/alpha', '2025-02-01T12:00:00.000Z') // id 200 (new repo, same name)
    recordObservedBinding(100, 'orchard/alpha', '2024-06-01T12:00:00.000Z', db)
    recordObservedBinding(200, 'orchard/alpha', '2025-02-01T12:00:00.000Z', db)

    expect(getSnapshotHistoryForIdentity(100, {}, db).map((r) => r.observedAt)).toEqual([
      '2024-06-01T12:00:00.000Z',
    ])
    expect(getSnapshotHistoryForIdentity(200, {}, db).map((r) => r.observedAt)).toEqual([
      '2025-02-01T12:00:00.000Z',
    ])
  })

  it('returns nothing for an identity with no bindings', () => {
    seedSnapshot('orchard/alpha', '2025-01-01T12:00:00.000Z')
    expect(getSnapshotHistoryForIdentity(999, {}, db)).toEqual([])
    expect(getDeclarationHistoryForIdentity(999, 10, db)).toEqual([])
  })

  it('respects since and limit', () => {
    for (let d = 1; d <= 5; d++) {
      seedSnapshot('orchard/alpha', `2025-01-0${d}T12:00:00.000Z`)
    }
    recordObservedBinding(100, 'orchard/alpha', '2025-01-05T12:00:00.000Z', db)
    recordObservedBinding(100, 'orchard/alpha', '2025-01-01T12:00:00.000Z', db)
    expect(
      getSnapshotHistoryForIdentity(100, { since: '2025-01-03T00:00:00.000Z' }, db),
    ).toHaveLength(3)
    expect(getSnapshotHistoryForIdentity(100, { limit: 2 }, db)).toHaveLength(2)
  })

  it('declaration history follows the same bindings', () => {
    seedDeclaration('org-old/thing', '2024-11-01T12:00:00.000Z', 'emerging')
    seedDeclaration('org/thing', '2025-01-01T12:00:00.000Z', 'expanding')
    recordResolvedBinding(
      {
        githubId: 100,
        fullName: 'org-old/thing',
        firstObservedAt: '2024-11-01T12:00:00.000Z',
        lastObservedAt: '2024-11-01T12:00:00.000Z',
        resolvedAt: '2025-01-01T00:00:00.000Z',
        evidence: {},
      },
      db,
    )
    recordObservedBinding(100, 'org/thing', '2025-01-01T12:00:00.000Z', db)
    expect(getDeclarationHistoryForIdentity(100, 10, db).map((r) => r.phase)).toEqual([
      'expanding',
      'emerging',
    ])
  })
})

describe('getObservedSpanForName / listUnboundNames', () => {
  it('reports the earliest and latest snapshot under a name', () => {
    seedSnapshot('orchard/alpha', '2025-01-03T12:00:00.000Z')
    seedSnapshot('orchard/alpha', '2025-01-01T12:00:00.000Z')
    expect(getObservedSpanForName('orchard/alpha', db)).toEqual({
      first: '2025-01-01T12:00:00.000Z',
      last: '2025-01-03T12:00:00.000Z',
    })
    expect(getObservedSpanForName('orchard/none', db)).toBeUndefined()
  })

  it('lists names without any binding', () => {
    seedRepo('orchard/alpha')
    seedRepo('orchard/beta')
    recordObservedBinding(100, 'orchard/alpha', '2025-01-01T12:00:00.000Z', db)
    expect(listUnboundNames(db)).toEqual(['orchard/beta'])
  })
})

describe('getPortfolioCalendarWindow', () => {
  it('builds explicit empty slots for days without observation', () => {
    seedSnapshot('orchard/alpha', '2025-01-14T12:00:00.000Z')
    seedSnapshot('orchard/alpha', '2025-01-12T12:00:00.000Z')
    const windows = getPortfolioCalendarWindow(
      [{ fullName: 'orchard/alpha' }],
      '2025-01-14',
      3,
      db,
    )
    const slots = windows.get('orchard/alpha')!
    expect(slots.map((s) => s.day)).toEqual(['2025-01-14', '2025-01-13', '2025-01-12'])
    expect(slots[1].snapshot).toBeUndefined()
  })

  it('follows identity across a rename', () => {
    seedSnapshot('org-old/thing', '2025-01-12T12:00:00.000Z')
    seedSnapshot('org/thing', '2025-01-14T12:00:00.000Z')
    recordResolvedBinding(
      {
        githubId: 100,
        fullName: 'org-old/thing',
        firstObservedAt: '2025-01-12T12:00:00.000Z',
        lastObservedAt: '2025-01-12T12:00:00.000Z',
        resolvedAt: '2025-01-14T00:00:00.000Z',
        evidence: {},
      },
      db,
    )
    recordObservedBinding(100, 'org/thing', '2025-01-14T12:00:00.000Z', db)
    const windows = getPortfolioCalendarWindow(
      [{ fullName: 'org/thing', githubId: 100 }],
      '2025-01-14',
      3,
      db,
    )
    const slots = windows.get('org/thing')!
    expect(slots[0].snapshot?.fullName).toBe('org/thing')
    expect(slots[1].snapshot).toBeUndefined()
    expect(slots[2].snapshot?.fullName).toBe('org-old/thing')
  })

  it('falls back to the name when the identity has no bindings yet', () => {
    seedSnapshot('orchard/alpha', '2025-01-14T12:00:00.000Z')
    const windows = getPortfolioCalendarWindow(
      [{ fullName: 'orchard/alpha', githubId: 100 }],
      '2025-01-14',
      1,
      db,
    )
    expect(windows.get('orchard/alpha')![0].snapshot).toBeDefined()
  })
})
