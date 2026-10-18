import type { Horizon, Phase, Role } from '@grove/core'
import { deriveSeason } from '@grove/core'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { getActiveProposal, persistProposal } from '../db'
import { createDb, type GroveDb } from '../db/client'
import { climateProposals, ecologySnapshots, repositories } from '../db/schema'
import { evaluatePortfolioProposals, type TriggerSubject } from '../ecosystem-triggers'

let db: GroveDb

beforeEach(() => {
  db = createDb(new Database(':memory:'))
})

const END_DAY = '2025-01-28'
const STEWARD = 7

function repo(
  fullName: string,
  horizon: Horizon,
  role: Role,
  phase: Phase,
  githubId?: number,
): TriggerSubject {
  return {
    fullName,
    htmlUrl: `https://github.com/${fullName}`,
    classified: true,
    declaration: { intent: 'test', horizon, role, phase },
    season: deriveSeason(phase),
    ...(githubId !== undefined ? { githubId } : {}),
  }
}

function seed(fullName: string, phase: string, count: number, startDay = 1) {
  db.insert(repositories)
    .values({
      fullName,
      htmlUrl: `https://github.com/${fullName}`,
      defaultBranch: 'main',
      lastObservedAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run()
  for (let i = 0; i < count; i++) {
    db.insert(ecologySnapshots)
      .values({
        fullName,
        observedAt: `2025-01-${String(startDay + i).padStart(2, '0')}T12:00:00Z`,
        classified: true,
        phase,
      })
      .run()
  }
}

const activeProposal = () => db.select().from(climateProposals).all()[0]

describe('proposal source membership', () => {
  it('records the repositories a new proposal drew on', () => {
    seed('org/core-a', 'expanding', 28) // divergent from dormancy across both windows
    seed('org/app-b', 'resting', 28) // aligned, long-arc domain (not Set A: no split)
    const portfolio = [
      repo('org/core-a', 'perennial', 'infrastructure', 'expanding', 100),
      repo('org/app-b', 'perennial', 'application', 'resting', 200),
      repo('org/doc-c', 'perennial', 'documentation', 'resting'),
    ]
    const result = evaluatePortfolioProposals('dormancy', portfolio, STEWARD, db, END_DAY)
    expect(result?.triggerType).toBe('core_divergence')
    expect(JSON.parse(activeProposal().sourceRepositories ?? '[]')).toEqual([
      { fullName: 'org/core-a', githubId: 100 },
    ])
  })

  it('a source repository missing from the portfolio keeps the proposal not observed', () => {
    persistProposal(
      {
        climate: 'expansion',
        basis: 'sustained_core_divergence',
        triggerType: 'core_divergence',
        observedSeason: 'expansion',
      },
      'synthetic',
      STEWARD,
      db,
      [{ fullName: 'org/core-a', githubId: 100 }],
    )
    // core-a is gone from the selected portfolio; core-b is fully observed and aligned.
    seed('org/core-b', 'resting', 14, 15)
    const portfolio = [repo('org/core-b', 'perennial', 'infrastructure', 'resting', 200)]
    const result = evaluatePortfolioProposals('dormancy', portfolio, STEWARD, db, END_DAY)
    expect(result?.evidence).toBe('not_observed')
    expect(getActiveProposal(STEWARD, db)?.status).toBe('active')
  })

  it('the pattern carried by a repository the proposal did not draw on does not support it', () => {
    persistProposal(
      {
        climate: 'expansion',
        basis: 'sustained_core_divergence',
        triggerType: 'core_divergence',
        observedSeason: 'expansion',
      },
      'synthetic',
      STEWARD,
      db,
      [{ fullName: 'org/core-a', githubId: 100 }],
    )
    // The source is fully observed and aligned now; an unrelated core
    // repository diverges in the same direction the proposal recorded.
    seed('org/core-a', 'resting', 14, 15)
    seed('org/core-b', 'expanding', 14, 15)
    const portfolio = [
      repo('org/core-a', 'perennial', 'infrastructure', 'resting', 100),
      repo('org/core-b', 'perennial', 'infrastructure', 'expanding', 200),
    ]
    const result = evaluatePortfolioProposals('dormancy', portfolio, STEWARD, db, END_DAY)
    expect(result).toBeUndefined()
    expect(activeProposal().status).toBe('withdrawn')
  })

  it('a missing source stays not observed even when another repository carries the pattern', () => {
    persistProposal(
      {
        climate: 'expansion',
        basis: 'sustained_core_divergence',
        triggerType: 'core_divergence',
        observedSeason: 'expansion',
      },
      'synthetic',
      STEWARD,
      db,
      [{ fullName: 'org/core-a', githubId: 100 }],
    )
    seed('org/core-b', 'expanding', 14, 15)
    const supportedAtCreation = activeProposal().lastSupportedAt
    const portfolio = [repo('org/core-b', 'perennial', 'infrastructure', 'expanding', 200)]
    const result = evaluatePortfolioProposals('dormancy', portfolio, STEWARD, db, END_DAY)
    expect(result?.evidence).toBe('not_observed')
    expect(getActiveProposal(STEWARD, db)?.status).toBe('active')
    expect(getActiveProposal(STEWARD, db)?.lastSupportedAt).toBe(supportedAtCreation)
  })

  it('a source repository present under a new name (same identity) still counts', () => {
    persistProposal(
      {
        climate: 'expansion',
        basis: 'sustained_core_divergence',
        triggerType: 'core_divergence',
        observedSeason: 'expansion',
      },
      'synthetic',
      STEWARD,
      db,
      [{ fullName: 'org-old/core-a', githubId: 100 }],
    )
    seed('org/core-a', 'resting', 14, 15) // renamed, fully observed, aligned now
    const portfolio = [repo('org/core-a', 'perennial', 'infrastructure', 'resting', 100)]
    const result = evaluatePortfolioProposals('dormancy', portfolio, STEWARD, db, END_DAY)
    expect(result).toBeUndefined()
    expect(activeProposal().status).toBe('withdrawn')
  })

  it('a proposal recorded before source tracking falls back to the stratum rule', () => {
    persistProposal(
      {
        climate: 'expansion',
        basis: 'sustained_core_divergence',
        triggerType: 'core_divergence',
        observedSeason: 'expansion',
      },
      'synthetic',
      STEWARD,
      db,
    )
    seed('org/core-b', 'resting', 14, 15)
    const portfolio = [repo('org/core-b', 'perennial', 'infrastructure', 'resting', 200)]
    const result = evaluatePortfolioProposals('dormancy', portfolio, STEWARD, db, END_DAY)
    expect(result).toBeUndefined()
    expect(activeProposal().status).toBe('withdrawn')
  })
})
