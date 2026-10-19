import type { Horizon, Phase, Role } from '@grove/core'
import { deriveSeason } from '@grove/core'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { createDb, type GroveDb } from '../db/client'
import { getDeclarationHistory, getLatestDeclaration, recordDeclarationIfChanged } from '../db/declarations'
import { declarationChanges, ecologySnapshots, repositories } from '../db/schema'
import { evaluatePortfolioEcosystemTriggers, type TriggerSubject } from '../ecosystem-triggers'
import { buildGapEntries, buildHistorySpanEntries, buildTimeline } from '../timeline'

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
  it('rows recorded from history never close a span without observation', () => {
    const rows = [
      row('2025-06-01T12:00:00.000Z', 'observed'),
      row('2025-03-01T23:59:59.999Z', 'history'),
      row('2025-01-01T12:00:00.000Z', 'observed'),
    ]
    const gaps = buildGapEntries(rows)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ lastObservedAt: '2025-01-01T12:00:00.000Z', days: 151 })
  })

  it('consecutive history days form one span entry, presented beside the gap', () => {
    const rows = [
      row('2025-06-01T12:00:00.000Z', 'observed'),
      row('2025-01-04T23:59:59.999Z', 'history'),
      row('2025-01-03T23:59:59.999Z', 'history'),
      row('2025-01-02T23:59:59.999Z', 'history'),
      row('2024-12-20T23:59:59.999Z', 'history'),
      row('2025-01-01T12:00:00.000Z', 'observed'),
    ]
    const spans = buildHistorySpanEntries(rows)
    expect(spans.map((s) => s.kind === 'history_span' && [s.observedAt.slice(0, 10), s.spanEnd.slice(0, 10), s.days])).toEqual([
      ['2024-12-20', '2024-12-20', 1],
      ['2025-01-02', '2025-01-04', 3],
    ])
    const timeline = buildTimeline(rows, [], false, true)
    expect(timeline.filter((e) => e.kind === 'observation_gap')).toHaveLength(1)
    expect(timeline.filter((e) => e.kind === 'history_span')).toHaveLength(2)
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
