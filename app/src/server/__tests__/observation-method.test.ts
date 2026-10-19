import type { Horizon, Phase, Role } from '@grove/core'
import { deriveSeason } from '@grove/core'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { createDb, type GroveDb } from '../db/client'
import { getDeclarationHistory, getLatestDeclaration, recordDeclarationIfChanged } from '../db/declarations'
import { declarationChanges, ecologySnapshots, repositories } from '../db/schema'
import { evaluatePortfolioEcosystemTriggers, type TriggerSubject } from '../ecosystem-triggers'
import { buildGapEntries, buildTimeline } from '../timeline'

let db: GroveDb

beforeEach(() => {
  db = createDb(new Database(':memory:'))
})

type SnapshotRow = typeof ecologySnapshots.$inferSelect

let id = 0
function row(observedAt: string, method: 'observed' | 'history', overrides: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    id: ++id,
    fullName: 'org/thing',
    githubId: 100,
    observedAt,
    method,
    recordedAt: method === 'history' ? '2025-10-19T10:00:00.000Z' : null,
    collectionRunId: null,
    evidence: null,
    classified: true,
    intent: 'synthetic',
    horizon: 'perennial',
    role: 'library',
    phase: 'consolidating',
    steward: null,
    consolidationIntervalDays: null,
    fileCount: null,
    commitsLast30d: null,
    commitsLast90d: null,
    dependencyManifestsObserved: null,
    ecosystemDependencyCount: null,
    densityTier: null,
    densityDescription: null,
    ...overrides,
  }
}

describe('spans recorded from history', () => {
  it('a row recorded from history is a day like any other: it closes a span', () => {
    const rows = [
      row('2025-06-01T12:00:00.000Z', 'observed'),
      row('2025-03-01T23:59:59.999Z', 'history'),
      row('2025-01-01T12:00:00.000Z', 'observed'),
    ]
    const gaps = buildGapEntries(rows)
    expect(gaps.map((g) => g.kind === 'observation_gap' && [g.lastObservedAt, g.days])).toEqual([
      ['2025-01-01T12:00:00.000Z', 59],
      ['2025-03-01T23:59:59.999Z', 91],
    ])
  })

  it('a run of days filled from history leaves no span without rows', () => {
    const rows = [row('2025-01-05T12:00:00.000Z', 'observed')]
    rows.push(
      row('2025-01-04T23:59:59.999Z', 'history'),
      row('2025-01-03T23:59:59.999Z', 'history'),
      row('2025-01-02T23:59:59.999Z', 'history'),
      row('2025-01-01T12:00:00.000Z', 'observed'),
    )
    const timeline = buildTimeline(rows, [], false, true)
    expect(timeline.some((e) => e.kind === 'observation_gap')).toBe(false)
  })
})

describe('density entries say which method they were read from', () => {
  it('a transition read from a history row, and spans of one or both methods, are marked', () => {
    const rows = [
      row('2025-01-05T12:00:00.000Z', 'observed', { densityTier: 'thickening' }),
      row('2025-01-04T23:59:59.999Z', 'history', { densityTier: 'thickening' }),
      row('2025-01-03T23:59:59.999Z', 'history', { densityTier: 'rooting' }),
      row('2025-01-02T23:59:59.999Z', 'history', { densityTier: 'rooting' }),
      row('2025-01-01T12:00:00.000Z', 'observed', { densityTier: 'rooting' }),
    ]
    const timeline = buildTimeline(rows, [], false, true)
    const transition = timeline.find((e) => e.kind === 'density_transition' && e.fromTier !== null)
    expect(transition).toMatchObject({ toTier: 'thickening', method: 'history' })
    const spans = timeline.filter((e) => e.kind === 'density_span')
    expect(spans.map((s) => s.kind === 'density_span' && [s.tier, s.method])).toEqual([
      ['thickening', 'mixed'],
      ['rooting', 'mixed'],
    ])
  })

  it('a span counts its days, not its rows: two rows on one UTC day are one day', () => {
    const rows = [
      row('2025-01-02T23:59:59.999Z', 'history', { densityTier: 'rooting' }),
      row('2025-01-02T12:00:00.000Z', 'observed', { densityTier: 'rooting' }),
      row('2025-01-01T12:00:00.000Z', 'observed', { densityTier: 'rooting' }),
    ]
    const span = buildTimeline(rows, [], false, true).find((e) => e.kind === 'density_span')
    expect(span).toMatchObject({ observationCount: 3, days: 2 })
  })
})

describe('a long reconstructed run does not crowd the gap out of a bounded window', () => {
  it('spans come from the separately fetched series: observed rows and every history day', () => {
    // The bounded window holds only the newest rows. The full series has a
    // 170-day stretch with no observed row, filled by history days.
    const window: SnapshotRow[] = [row('2025-10-19T12:00:00.000Z', 'observed'), row('2025-10-18T12:00:00.000Z', 'observed')]
    const observed = {
      snapshots: [
        row('2025-10-19T12:00:00.000Z', 'observed'),
        row('2025-10-18T12:00:00.000Z', 'observed'),
        row('2025-05-01T12:00:00.000Z', 'observed'),
      ],
      complete: true,
    }
    const historyDays: Array<{ observedAt: string; recordedAt: string | null }> = []
    for (let i = 0; i < 169; i++) {
      const d = new Date(Date.UTC(2025, 9, 17) - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      historyDays.push({ observedAt: `${d}T23:59:59.999Z`, recordedAt: '2025-10-19T10:00:00.000Z' })
    }
    const filled = buildTimeline(window, [], false, false, undefined, true, {
      observed: { ...observed, declarations: [], declarationsComplete: true },
      historyDays,
    })
    expect(filled.some((e) => e.kind === 'observation_gap')).toBe(false)

    // Without the history days the same stretch is a span with no row.
    const empty = buildTimeline(window, [], false, false, undefined, true, {
      observed: { ...observed, declarations: [], declarationsComplete: true },
      historyDays: [],
    })
    expect(empty.find((e) => e.kind === 'observation_gap')).toMatchObject({
      lastObservedAt: '2025-05-01T12:00:00.000Z',
      days: 170,
    })
  })
})

describe('declarations are ordered by observation time, not insertion', () => {
  it('an older declaration inserted later is not the latest', () => {
    db.insert(repositories)
      .values({ fullName: 'org/thing', htmlUrl: 'https://github.com/org/thing', defaultBranch: 'main', lastObservedAt: '2025-01-01T00:00:00.000Z' })
      .run()
    recordDeclarationIfChanged('org/thing', { intent: 'now', phase: 'consolidating' }, true, db, 100)
    db.insert(declarationChanges)
      .values({
        fullName: 'org/thing',
        githubId: 100,
        observedAt: '2024-06-01T00:00:00.000Z',
        method: 'history',
        classified: true,
        intent: 'then',
        phase: 'expanding',
      })
      .run()
    expect(getLatestDeclaration('org/thing', db)?.intent).toBe('now')
    expect(getDeclarationHistory('org/thing', 10, db).map((d) => d.intent)).toEqual(['now', 'then'])
    // Dedupe compares against the chronologically latest row.
    expect(recordDeclarationIfChanged('org/thing', { intent: 'now', phase: 'consolidating' }, true, db, 100)).toBe(false)
  })
})

describe('strata must hold across a window', () => {
  function repo(fullName: string, horizon: Horizon, role: Role, phase: Phase): TriggerSubject {
    return {
      fullName,
      htmlUrl: `https://github.com/${fullName}`,
      classified: true,
      declaration: { intent: 'test', horizon, role, phase },
      season: deriveSeason(phase),
      githubId: 100,
    }
  }

  function seed(role: string, days: number[]) {
    for (const d of days) {
      db.insert(ecologySnapshots)
        .values({
          fullName: 'org/core',
          githubId: 100,
          observedAt: `2025-01-${String(d).padStart(2, '0')}T12:00:00Z`,
          classified: true,
          phase: 'expanding',
          horizon: 'perennial',
          role,
        })
        .run()
    }
  }

  beforeEach(() => {
    db.insert(repositories)
      .values({ fullName: 'org/core', htmlUrl: 'https://github.com/org/core', defaultBranch: 'main', lastObservedAt: '2025-01-01T00:00:00.000Z' })
      .run()
  })

  it('a window whose rows agree on role and horizon is examined', () => {
    seed('infrastructure', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
    const result = evaluatePortfolioEcosystemTriggers(
      'dormancy',
      [repo('org/core', 'perennial', 'infrastructure', 'expanding')],
      db,
      '2025-01-14',
    )
    expect(result?.coreDivergence.map((c) => c.fullName)).toEqual(['org/core'])
  })

  it('rows that disagree with the current declaration, or lack one, make the window undeterminable', () => {
    // Rows agree among themselves but the repository now declares another role.
    seed('application', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
    expect(
      evaluatePortfolioEcosystemTriggers(
        'dormancy',
        [repo('org/core', 'perennial', 'infrastructure', 'expanding')],
        db,
        '2025-01-14',
      ),
    ).toBeUndefined()
  })

  it('a window whose rows change role is undeterminable for stratum-based triggers', () => {
    seed('application', [1, 2, 3, 4, 5, 6, 7])
    seed('infrastructure', [8, 9, 10, 11, 12, 13, 14])
    const result = evaluatePortfolioEcosystemTriggers(
      'dormancy',
      [repo('org/core', 'perennial', 'infrastructure', 'expanding')],
      db,
      '2025-01-14',
    )
    expect(result).toBeUndefined()
  })
})
