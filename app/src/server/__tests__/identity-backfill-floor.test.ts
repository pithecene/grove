import type { RepositoryResolution } from '@grove/github'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { getBindingsForIdentity } from '../db/bindings'
import { createDb, type GroveDb } from '../db/client'
import { ecologySnapshots, repositories } from '../db/schema'
import { backfillIdentities, type NameResolver } from '../identity-backfill'

let db: GroveDb

beforeEach(() => {
  db = createDb(new Database(':memory:'))
})

function seedName(fullName: string, snapshotDays: string[]) {
  db.insert(repositories)
    .values({
      fullName,
      htmlUrl: `https://github.com/${fullName}`,
      defaultBranch: 'main',
      lastObservedAt: '2025-01-01T00:00:00.000Z',
    })
    .run()
  for (const day of snapshotDays) {
    db.insert(ecologySnapshots)
      .values({ fullName, observedAt: `${day}T12:00:00.000Z`, classified: false })
      .run()
  }
}

const resolvedTo = (id: number, fullName: string, createdAt: string): RepositoryResolution => ({
  outcome: 'resolved',
  status: 200,
  repo: {
    id,
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    default_branch: 'main',
    pushed_at: null,
    created_at: createdAt,
  },
})

const clock = () => '2025-02-01T00:00:00.000Z'

describe('backfill floors a name by the identity’s observations under other names', () => {
  it('leaves rows under a taken-over name unbound until after the last observation elsewhere', async () => {
    // 'orchard/reused' was recorded Jan 5–20. Identity 300 was created on
    // Jan 1 but observed under 'orchard/former' on Jan 12, so it cannot have
    // held 'orchard/reused' before then — one name at a time.
    seedName('orchard/reused', ['2025-01-05', '2025-01-10', '2025-01-15', '2025-01-20'])
    seedName('orchard/former', ['2025-01-12'])
    const pair: NameResolver = async (name) =>
      name === 'orchard/former' || name === 'orchard/reused'
        ? resolvedTo(300, 'orchard/reused', '2025-01-01T00:00:00.000Z')
        : { outcome: 'error', status: 500, message: 'synthetic' }

    const report = await backfillIdentities(db, pair, { apply: true, now: clock })
    const reused = report.entries.find((e) => e.fullName === 'orchard/reused')
    expect(reused?.outcome).toBe('name_reused')
    expect(reused?.floorBasis).toBe('previous_name_observation')
    expect(reused?.previousName).toBe('orchard/former')
    expect(reused?.boundSpan).toEqual({
      first: '2025-01-12T12:00:00.000Z',
      last: '2025-01-20T12:00:00.000Z',
    })
    expect(reused?.unboundSpan).toEqual({
      first: '2025-01-05T12:00:00.000Z',
      last: '2025-01-12T12:00:00.000Z',
    })
    expect(getBindingsForIdentity(300, db).map((b) => [b.fullName, b.firstObservedAt])).toEqual(
      [
        ['orchard/former', '2025-01-12T12:00:00.000Z'],
        ['orchard/reused', '2025-01-12T12:00:00.000Z'],
      ],
    )

    // Re-running changes nothing.
    const again = await backfillIdentities(db, pair, { apply: true, now: clock })
    expect(again.bindingsInserted).toBe(0)
  })

  it('binds in the order observations end regardless of the order names are listed', async () => {
    seedName('orchard/reused', ['2025-01-05', '2025-01-20'])
    seedName('orchard/former', ['2025-01-12'])
    const pair: NameResolver = async () =>
      resolvedTo(300, 'orchard/reused', '2024-06-01T00:00:00.000Z')
    const report = await backfillIdentities(db, pair, {
      apply: false,
      names: ['orchard/reused', 'orchard/former'],
      now: clock,
    })
    expect(report.entries.map((e) => e.fullName)).toEqual(['orchard/former', 'orchard/reused'])
    // A dry run writes nothing, so the floor cannot come from a binding
    // that was not recorded; the report still says what would be bound.
    expect(report.entries[1].outcome).toBe('bound')
  })

  it('creation time remains the floor when the identity was never observed elsewhere', async () => {
    seedName('orchard/reused', ['2025-01-05', '2025-01-20'])
    const only: NameResolver = async () =>
      resolvedTo(300, 'orchard/reused', '2025-01-10T00:00:00.000Z')
    const report = await backfillIdentities(db, only, { apply: true, now: clock })
    expect(report.entries[0]).toMatchObject({
      outcome: 'name_reused',
      floorBasis: 'created_at',
      boundSpan: { first: '2025-01-10T00:00:00.000Z', last: '2025-01-20T12:00:00.000Z' },
      unboundSpan: { first: '2025-01-05T12:00:00.000Z', last: '2025-01-10T00:00:00.000Z' },
    })
  })
})
