import type { RepositoryEcology } from '@grove/core'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  getBindingsForIdentity,
  getBindingsForName,
  getDeclarationHistoryForIdentity,
  getSnapshotHistoryForIdentity,
  listUnboundNames,
  recordObservedBinding,
} from '../bindings'
import { createDb, type GroveDb } from '../client'
import { recordDeclarationIfChanged } from '../declarations'
import { declarationChanges, ecologySnapshots, repositories } from '../schema'
import { recordSnapshot, upsertRepositories } from '../snapshots'

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

function seedSnapshot(fullName: string, observedAt: string) {
  seedRepo(fullName)
  db.insert(ecologySnapshots)
    .values({ fullName, observedAt, classified: true, phase: 'expanding' })
    .run()
}

function seedDeclaration(fullName: string, observedAt: string) {
  seedRepo(fullName)
  db.insert(declarationChanges)
    .values({
      fullName,
      observedAt,
      classified: true,
      intent: 'synthetic',
      phase: 'expanding',
    })
    .run()
}

const ecology = (fullName: string): RepositoryEcology => ({
  fullName,
  htmlUrl: `https://github.com/${fullName}`,
  classified: true,
  declaration: { intent: 'synthetic', phase: 'expanding' },
})

describe('first binding on a database recorded before identity tracking', () => {
  it('adopts the rows already stored under the name', () => {
    seedSnapshot('orchard/alpha', '2024-11-01T12:00:00.000Z')
    seedSnapshot('orchard/alpha', '2024-12-01T12:00:00.000Z')
    seedDeclaration('orchard/alpha', '2024-11-01T12:00:00.100Z')

    upsertRepositories(
      [
        {
          fullName: 'orchard/alpha',
          htmlUrl: 'https://github.com/orchard/alpha',
          defaultBranch: 'main',
          githubId: 100,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ],
      db,
    )

    const binding = getBindingsForIdentity(100, db)[0]
    expect(binding.firstObservedAt).toBe('2024-11-01T12:00:00.000Z')
    expect(JSON.parse(binding.evidence ?? '{}')).toMatchObject({
      adopted_prior_rows: true,
      earliest_row: '2024-11-01T12:00:00.000Z',
      created_at: '2024-01-01T00:00:00.000Z',
    })
    expect(getSnapshotHistoryForIdentity(100, {}, db)).toHaveLength(2)
    expect(getDeclarationHistoryForIdentity(100, 10, db)).toHaveLength(1)
    expect(listUnboundNames(db)).toEqual([])
  })

  it('never adopts rows older than the repository itself', () => {
    seedSnapshot('orchard/alpha', '2024-06-01T12:00:00.000Z') // before creation: another repository's
    seedSnapshot('orchard/alpha', '2024-12-01T12:00:00.000Z')
    recordObservedBinding(
      200,
      'orchard/alpha',
      '2025-01-01T12:00:00.000Z',
      db,
      '2024-09-01T00:00:00.000Z',
    )

    const binding = getBindingsForIdentity(200, db)[0]
    expect(binding.firstObservedAt).toBe('2024-09-01T00:00:00.000Z')
    expect(getSnapshotHistoryForIdentity(200, {}, db).map((r) => r.observedAt)).toEqual([
      '2024-12-01T12:00:00.000Z',
    ])
  })

  it('does not adopt when the name already belongs to another identity (reuse)', () => {
    seedSnapshot('orchard/alpha', '2024-06-01T12:00:00.000Z')
    recordObservedBinding(100, 'orchard/alpha', '2024-06-01T12:00:00.000Z', db)
    recordObservedBinding(200, 'orchard/alpha', '2025-02-01T12:00:00.000Z', db)

    const reuse = getBindingsForIdentity(200, db)[0]
    expect(reuse.firstObservedAt).toBe('2025-02-01T12:00:00.000Z')
    expect(reuse.evidence).toBeNull()
    expect(getSnapshotHistoryForIdentity(200, {}, db)).toEqual([])
  })

  it('starts at the observation when nothing was stored before', () => {
    seedRepo('orchard/alpha')
    recordObservedBinding(
      100,
      'orchard/alpha',
      '2025-01-01T12:00:00.000Z',
      db,
      '2024-01-01T00:00:00.000Z',
    )
    expect(getBindingsForIdentity(100, db)[0].firstObservedAt).toBe(
      '2025-01-01T12:00:00.000Z',
    )
  })
})

describe('adoption floored by the identity’s own history', () => {
  it('adopts no rows older than the identity’s last observation under another name', () => {
    // The name was recorded monthly before identity tracking. The repository
    // (created in 2024) was observed live under another name in mid-March,
    // so it cannot have held this name before then — whatever `created_at` says.
    for (const month of ['01', '02', '03', '04']) {
      seedSnapshot('orchard/alpha', `2025-${month}-01T12:00:00.000Z`)
    }
    seedSnapshot('orchard/beta', '2025-03-15T12:00:00.000Z')
    recordObservedBinding(100, 'orchard/beta', '2025-03-15T12:00:00.000Z', db)
    recordObservedBinding(
      100,
      'orchard/alpha',
      '2025-05-01T12:00:00.000Z',
      db,
      '2024-01-01T00:00:00.000Z',
    )

    const alpha = getBindingsForName('orchard/alpha', db)[0]
    expect(alpha.firstObservedAt).toBe('2025-03-15T12:00:00.000Z')
    expect(JSON.parse(alpha.evidence ?? '{}')).toMatchObject({
      adopted_prior_rows: true,
      floor_basis: 'previous_name_observation',
      previous_name: 'orchard/beta',
    })
    expect(getSnapshotHistoryForIdentity(100, {}, db).map((r) => r.observedAt)).toEqual([
      '2025-04-01T12:00:00.000Z',
      '2025-03-15T12:00:00.000Z',
    ])
  })

  it('a tagged observation under another name floors adoption even with no binding for it', () => {
    for (const month of ['01', '02', '03', '04']) {
      seedSnapshot('orchard/alpha', `2025-${month}-01T12:00:00.000Z`)
    }
    // Identity 100 observed under orchard/beta in mid-March, recorded with
    // its id but no binding (the state row identity explicitly supports).
    seedRepo('orchard/beta')
    db.insert(ecologySnapshots)
      .values({
        fullName: 'orchard/beta',
        githubId: 100,
        observedAt: '2025-03-15T12:00:00.000Z',
        classified: true,
      })
      .run()
    recordObservedBinding(
      100,
      'orchard/alpha',
      '2025-05-01T12:00:00.000Z',
      db,
      '2024-01-01T00:00:00.000Z',
    )
    const alpha = getBindingsForName('orchard/alpha', db)[0]
    expect(alpha.firstObservedAt).toBe('2025-03-15T12:00:00.000Z')
    expect(JSON.parse(alpha.evidence ?? '{}')).toMatchObject({
      floor_basis: 'previous_name_observation',
      previous_name: 'orchard/beta',
    })
  })

  it('records the creation time as the basis when nothing stronger is known', () => {
    seedSnapshot('orchard/alpha', '2025-01-01T12:00:00.000Z')
    seedSnapshot('orchard/alpha', '2025-02-01T12:00:00.000Z')
    recordObservedBinding(
      100,
      'orchard/alpha',
      '2025-03-01T12:00:00.000Z',
      db,
      '2025-01-15T00:00:00.000Z',
    )
    const alpha = getBindingsForName('orchard/alpha', db)[0]
    expect(alpha.firstObservedAt).toBe('2025-01-15T00:00:00.000Z')
    expect(JSON.parse(alpha.evidence ?? '{}')).toMatchObject({ floor_basis: 'created_at' })
  })
})

describe('exact binding bounds', () => {
  it('rows recorded after the binding in the same request extend it', () => {
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
    const before = getBindingsForName('orchard/alpha', db)[0].lastObservedAt
    // recordSnapshot / recordDeclarationIfChanged stamp their own, later, time.
    expect(recordSnapshot(ecology('orchard/alpha'), undefined, undefined, db)).toBe(true)
    recordDeclarationIfChanged(
      'orchard/alpha',
      ecology('orchard/alpha').declaration,
      true,
      db,
    )

    const binding = getBindingsForName('orchard/alpha', db)[0]
    expect(binding.lastObservedAt >= before).toBe(true)
    expect(getSnapshotHistoryForIdentity(100, {}, db)).toHaveLength(1)
    expect(getDeclarationHistoryForIdentity(100, 10, db)).toHaveLength(1)
  })

  it('attributes same-day name reuse by the exact instant the new binding began', () => {
    seedSnapshot('orchard/alpha', '2025-02-01T08:00:00.000Z') // old identity, morning
    seedSnapshot('orchard/alpha', '2025-02-01T18:00:00.000Z') // new identity, evening
    recordObservedBinding(100, 'orchard/alpha', '2025-02-01T08:00:00.000Z', db)
    recordObservedBinding(200, 'orchard/alpha', '2025-02-01T17:00:00.000Z', db)
    // the evening snapshot extends the current (new) binding
    recordObservedBinding(200, 'orchard/alpha', '2025-02-01T18:00:00.000Z', db)

    expect(getSnapshotHistoryForIdentity(100, {}, db).map((r) => r.observedAt)).toEqual([
      '2025-02-01T08:00:00.000Z',
    ])
    expect(getSnapshotHistoryForIdentity(200, {}, db).map((r) => r.observedAt)).toEqual([
      '2025-02-01T18:00:00.000Z',
    ])
  })

  it('repairs bounds left short by an earlier observation on the next one', () => {
    seedRepo('orchard/alpha')
    recordObservedBinding(100, 'orchard/alpha', '2025-01-01T12:00:00.000Z', db)
    // a row stored a moment after the binding, before bounds were extended
    seedSnapshot('orchard/alpha', '2025-01-01T12:00:00.050Z')
    expect(getSnapshotHistoryForIdentity(100, {}, db)).toHaveLength(0)

    recordObservedBinding(100, 'orchard/alpha', '2025-01-02T12:00:00.000Z', db)
    expect(getSnapshotHistoryForIdentity(100, {}, db)).toHaveLength(1)
  })
})
