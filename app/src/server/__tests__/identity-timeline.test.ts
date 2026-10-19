import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { recordObservedBinding } from '../db'
import { createDb, type GroveDb } from '../db/client'
import { ecologySnapshots, repositories } from '../db/schema'
import { timelineForIdentity } from '../identity-timeline'

let db: GroveDb
const ID = 100
const DAY = 24 * 60 * 60 * 1000

beforeEach(() => {
  db = createDb(new Database(':memory:'))
  db.insert(repositories)
    .values({
      fullName: 'orchard/alpha',
      htmlUrl: 'https://github.com/orchard/alpha',
      defaultBranch: 'main',
      lastObservedAt: '2025-10-18T12:00:00.000Z',
      githubId: ID,
    })
    .run()
  recordObservedBinding(ID, 'orchard/alpha', '2025-03-01T12:00:00.000Z', db)
  recordObservedBinding(ID, 'orchard/alpha', '2025-10-18T12:00:00.000Z', db)
})

function snap(observedAt: string, method: 'observed' | 'history', densityTier: string) {
  db.insert(ecologySnapshots)
    .values({
      fullName: 'orchard/alpha',
      githubId: ID,
      observedAt,
      method,
      classified: true,
      densityTier,
    })
    .run()
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

describe('timelineForIdentity', () => {
  it('reads the whole daily series, observed and reconstructed alike, with no span left empty', () => {
    // Observed in March, then 230 days recorded from history (Mar 2 – Oct 17), then observed again.
    snap('2025-03-01T12:00:00.000Z', 'observed', 'sparse')
    const start = Date.UTC(2025, 2, 2)
    for (let i = 0; i < 230; i++) {
      snap(
        `${day(start + i * DAY)}T23:59:59.999Z`,
        'history',
        i < 100 ? 'rooting' : 'thickening',
      )
    }
    snap('2025-10-18T12:00:00.000Z', 'observed', 'thickening')

    const { timeline, snapshots } = timelineForIdentity(ID, false, db)
    expect(snapshots).toHaveLength(232)
    // Nothing is cut off: the first recorded character and the shift a
    // hundred days into the reconstructed months are both on the timeline.
    expect(
      timeline.find((e) => e.kind === 'density_transition' && e.fromTier === null),
    ).toMatchObject({
      observedAt: '2025-03-01T12:00:00.000Z',
      toTier: 'sparse',
    })
    expect(
      timeline
        .filter((e) => e.kind === 'density_span')
        .map((e) => e.kind === 'density_span' && [e.tier, e.days]),
    ).toEqual([
      ['thickening', 131],
      ['rooting', 100],
    ])
    // Days recorded from history are days: no span without rows.
    expect(timeline.some((e) => e.kind === 'observation_gap')).toBe(false)
  })

  it('a stretch with no row of any kind is still a span without rows', () => {
    snap('2025-03-01T12:00:00.000Z', 'observed', 'rooting')
    snap('2025-10-18T12:00:00.000Z', 'observed', 'rooting')
    const { timeline } = timelineForIdentity(ID, false, db)
    expect(timeline.find((e) => e.kind === 'observation_gap')).toMatchObject({
      lastObservedAt: '2025-03-01T12:00:00.000Z',
      days: 231,
    })
  })
})
