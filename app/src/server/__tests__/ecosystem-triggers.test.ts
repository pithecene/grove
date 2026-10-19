import type { Horizon, Phase, Role } from '@grove/core'
import { deriveSeason } from '@grove/core'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { getActiveProposal, persistProposal } from '../db'
import { recordObservedBinding } from '../db/bindings'
import { createDb, type GroveDb } from '../db/client'
import { climateProposals, ecologySnapshots, repositories } from '../db/schema'
import {
  evaluatePortfolioEcosystemTriggers,
  evaluatePortfolioProposals,
  type TriggerSubject,
} from '../ecosystem-triggers'

let db: GroveDb

beforeEach(() => {
  const sqlite = new Database(':memory:')
  db = createDb(sqlite)
})

/** Seed days are 2025-01-01 … 2025-01-31; windows anchor on this day. */
const END_DAY = '2025-01-14'

// --- Helpers ---

function makeEcology(
  fullName: string,
  opts: { horizon?: Horizon; role?: Role; phase?: Phase; githubId?: number } = {},
): TriggerSubject {
  const classified = !!(opts.horizon && opts.role)
  const season = opts.phase ? deriveSeason(opts.phase) : undefined
  return {
    fullName,
    htmlUrl: `https://github.com/${fullName}`,
    classified,
    declaration: {
      intent: 'test',
      ...(opts.horizon ? { horizon: opts.horizon } : {}),
      ...(opts.role ? { role: opts.role } : {}),
      ...(opts.phase ? { phase: opts.phase } : {}),
    },
    ...(season ? { season } : {}),
    ...(opts.githubId !== undefined ? { githubId: opts.githubId } : {}),
  }
}

function seedRepo(fullName: string) {
  db.insert(repositories)
    .values({
      fullName,
      htmlUrl: `https://github.com/${fullName}`,
      defaultBranch: 'main',
      lastObservedAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run()
}

function dayOf(n: number): string {
  return `2025-01-${String(n).padStart(2, '0')}`
}

function seedSnapshots(fullName: string, phase: string, count: number, startDay = 1) {
  seedRepo(fullName)
  for (let i = 0; i < count; i++) {
    db.insert(ecologySnapshots)
      .values({
        fullName,
        observedAt: `${dayOf(startDay + i)}T12:00:00Z`,
        classified: true,
        phase,
      })
      .run()
  }
}

const core = (phase: Phase, extra: { githubId?: number } = {}) =>
  makeEcology('org/core', {
    horizon: 'perennial',
    role: 'infrastructure',
    phase,
    ...extra,
  })

// --- evaluatePortfolioEcosystemTriggers ---

describe('evaluatePortfolioEcosystemTriggers', () => {
  it('returns undefined when climate is undefined', () => {
    const repos = [core('expanding')]
    const result = evaluatePortfolioEcosystemTriggers(undefined, repos, db, END_DAY)
    expect(result).toBeUndefined()
  })

  it('returns undefined when no classified repos', () => {
    const repos = [makeEcology('org/unknown')]
    const result = evaluatePortfolioEcosystemTriggers('consolidation', repos, db, END_DAY)
    expect(result).toBeUndefined()
  })

  it('returns undefined when too few days in the window were observed', () => {
    const repos = [core('expanding')]
    // 5 observed days in a 14-day calendar window — threshold unreachable
    seedSnapshots('org/core', 'expanding', 5)
    const result = evaluatePortfolioEcosystemTriggers('dormancy', repos, db, END_DAY)
    expect(result).toBeUndefined()
  })

  it('returns triggered: false when data is sufficient but no persistent divergence', () => {
    const repos = [core('consolidating')]
    seedSnapshots('org/core', 'consolidating', 14)
    const result = evaluatePortfolioEcosystemTriggers('consolidation', repos, db, END_DAY)
    expect(result).toBeDefined()
    expect(result!.triggered).toBe(false)
  })

  it('fires §5.1 when structural core repo is persistently divergent', () => {
    const repos = [core('expanding')]
    seedSnapshots('org/core', 'expanding', 14)
    const result = evaluatePortfolioEcosystemTriggers('dormancy', repos, db, END_DAY)
    expect(result).toBeDefined()
    expect(result!.triggered).toBe(true)
    expect(result!.coreDivergence).toHaveLength(1)
    expect(result!.coreDivergence[0]!.fullName).toBe('org/core')
  })

  it('does not include unclassified repos in trigger evaluation', () => {
    const repos = [core('consolidating'), makeEcology('org/nogrove')]
    seedSnapshots('org/core', 'consolidating', 14)
    const result = evaluatePortfolioEcosystemTriggers('consolidation', repos, db, END_DAY)
    expect(result).toBeDefined()
    expect(result!.triggered).toBe(false)
    expect(result!.coreDivergence).toHaveLength(0)
  })

  it('a partial window with enough observed days still establishes persistence', () => {
    const repos = [core('expanding')]
    // 9 of the last 14 calendar days observed divergent, 5 not observed
    seedSnapshots('org/core', 'expanding', 9, 6)
    const result = evaluatePortfolioEcosystemTriggers('dormancy', repos, db, END_DAY)
    expect(result?.triggered).toBe(true)
  })

  it('a months-long absence is "not observed", not "no tension"', () => {
    const repos = [core('expanding')]
    seedSnapshots('org/core', 'expanding', 14)
    // Evaluate long after the last observation: the calendar window is empty.
    const result = evaluatePortfolioEcosystemTriggers('dormancy', repos, db, '2025-07-01')
    expect(result).toBeUndefined()
  })

  it('old snapshots are never stitched into the current window', () => {
    const repos = [core('expanding')]
    seedSnapshots('org/core', 'expanding', 13) // Jan 1–13
    seedRepo('org/core')
    db.insert(ecologySnapshots)
      .values({
        fullName: 'org/core',
        observedAt: '2025-07-01T12:00:00Z',
        classified: true,
        phase: 'expanding',
      })
      .run()
    // 14 rows exist, but only one falls inside the window ending 2025-07-01
    const result = evaluatePortfolioEcosystemTriggers('dormancy', repos, db, '2025-07-01')
    expect(result).toBeUndefined()
  })

  it('follows identity across a rename when the subject carries an id', () => {
    seedSnapshots('org-old/core', 'expanding', 7, 1) // Jan 1–7 under the old name
    seedSnapshots('org/core', 'expanding', 7, 8) // Jan 8–14 under the new name
    recordObservedBinding(100, 'org-old/core', '2025-01-01T12:00:00Z', db)
    recordObservedBinding(100, 'org-old/core', '2025-01-07T12:00:00Z', db)
    recordObservedBinding(100, 'org/core', '2025-01-08T12:00:00Z', db)
    recordObservedBinding(100, 'org/core', '2025-01-14T12:00:00Z', db)

    const withId = evaluatePortfolioEcosystemTriggers(
      'dormancy',
      [core('expanding', { githubId: 100 })],
      db,
      END_DAY,
    )
    expect(withId?.triggered).toBe(true)

    // By name alone, only 7 of 14 days are observed — insufficient.
    const byName = evaluatePortfolioEcosystemTriggers(
      'dormancy',
      [core('expanding')],
      db,
      END_DAY,
    )
    expect(byName).toBeUndefined()
  })
})

// --- evaluatePortfolioProposals ---

describe('evaluatePortfolioProposals', () => {
  const STEWARD = 42
  const portfolio = (phase: Phase = 'expanding'): TriggerSubject[] => [
    core(phase),
    makeEcology('org/app', {
      horizon: 'perennial',
      role: 'application',
      phase: 'resting',
    }),
    makeEcology('org/lib', { horizon: 'perennial', role: 'library', phase: 'resting' }),
  ]

  function activeRows() {
    return db.select().from(climateProposals).all()
  }

  it('proposes when both consecutive windows carry evidence of the same trigger', () => {
    seedSnapshots('org/core', 'expanding', 28) // Jan 1–28, divergent from dormancy
    const result = evaluatePortfolioProposals(
      'dormancy',
      portfolio(),
      STEWARD,
      db,
      dayOf(28),
    )
    expect(result).toMatchObject({
      climate: 'expansion',
      triggerType: 'core_divergence',
      evidence: 'supported',
    })
    expect(result?.lastSupportedAt).toBeDefined()
    expect(activeRows()).toHaveLength(1)
    expect(activeRows()[0].status).toBe('active')
    expect(activeRows()[0].lastSupportedAt).toBeDefined()
  })

  it('does not propose when the prior window was not observed', () => {
    seedSnapshots('org/core', 'expanding', 14, 15) // Jan 15–28 only
    const result = evaluatePortfolioProposals(
      'dormancy',
      portfolio(),
      STEWARD,
      db,
      dayOf(28),
    )
    expect(result).toBeUndefined()
    expect(activeRows()).toHaveLength(0)
  })

  it('keeps an existing proposal untouched when the current window lacks evidence', () => {
    persistProposal(
      {
        climate: 'expansion',
        basis: 'sustained_core_divergence',
        triggerType: 'core_divergence',
        observedSeason: 'expansion',
      },
      'synthetic observation',
      STEWARD,
      db,
    )
    const stored = getActiveProposal(STEWARD, db)!
    db.update(climateProposals).set({ lastSupportedAt: '2024-11-01T00:00:00.000Z' }).run()

    // No snapshots anywhere near the anchor day.
    const result = evaluatePortfolioProposals(
      'dormancy',
      portfolio(),
      STEWARD,
      db,
      '2025-06-01',
    )
    expect(result).toMatchObject({
      climate: 'expansion',
      evidence: 'not_observed',
      lastSupportedAt: '2024-11-01T00:00:00.000Z',
    })
    const row = activeRows().find((r) => r.id === stored.id)!
    expect(row.status).toBe('active')
    expect(row.lastSupportedAt).toBe('2024-11-01T00:00:00.000Z')
  })

  it('advances lastSupportedAt when the current window reproduces the pattern', () => {
    persistProposal(
      {
        climate: 'expansion',
        basis: 'sustained_core_divergence',
        triggerType: 'core_divergence',
        observedSeason: 'expansion',
      },
      'synthetic observation',
      STEWARD,
      db,
    )
    db.update(climateProposals).set({ lastSupportedAt: '2024-11-01T00:00:00.000Z' }).run()
    seedSnapshots('org/core', 'expanding', 14)

    const result = evaluatePortfolioProposals(
      'dormancy',
      portfolio(),
      STEWARD,
      db,
      END_DAY,
    )
    expect(result?.evidence).toBe('supported')
    expect(result?.lastSupportedAt).not.toBe('2024-11-01T00:00:00.000Z')
    expect(activeRows()[0].lastSupportedAt).not.toBe('2024-11-01T00:00:00.000Z')
    expect(activeRows()[0].status).toBe('active')
  })

  it('withdraws an existing proposal when current evidence shows the pattern reversed', () => {
    persistProposal(
      {
        climate: 'expansion',
        basis: 'sustained_core_divergence',
        triggerType: 'core_divergence',
        observedSeason: 'expansion',
      },
      'synthetic observation',
      STEWARD,
      db,
    )
    // Every structural-core repository (org/core, org/lib) fully observed and
    // aligned with dormancy: the pattern is absent with complete evidence.
    seedSnapshots('org/core', 'resting', 14)
    seedSnapshots('org/lib', 'resting', 14)

    const result = evaluatePortfolioProposals(
      'dormancy',
      portfolio('resting'),
      STEWARD,
      db,
      END_DAY,
    )
    expect(result).toBeUndefined()
    expect(activeRows()[0].status).toBe('withdrawn')
  })
})
