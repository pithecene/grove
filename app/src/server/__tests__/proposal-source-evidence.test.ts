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

const END_DAY = '2025-01-14'
const STEWARD = 7

function repo(
  fullName: string,
  horizon: Horizon,
  role: Role,
  phase: Phase,
): TriggerSubject {
  return {
    fullName,
    htmlUrl: `https://github.com/${fullName}`,
    classified: true,
    declaration: { intent: 'test', horizon, role, phase },
    season: deriveSeason(phase),
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
        // Rows carry the stratum the subject declares (role by name, as the subjects do).
        horizon: 'perennial',
        role: fullName.includes('core')
          ? 'infrastructure'
          : fullName.includes('app')
            ? 'application'
            : 'library',
      })
      .run()
  }
}

function activeCoreProposal() {
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
}

describe('proposal evidence is tied to the source stratum', () => {
  it('an unobserved core repository is not a reversal even when another repository has evidence', () => {
    activeCoreProposal()
    // Core repository A: only 8 observed days — threshold unreachable.
    seed('org/core-a', 'expanding', 8, 7)
    // Unrelated long-arc repository B: 14 observed, aligned days.
    seed('org/app-b', 'resting', 14)

    const portfolio = [
      repo('org/core-a', 'perennial', 'infrastructure', 'expanding'),
      repo('org/app-b', 'perennial', 'application', 'resting'),
      repo('org/lib-c', 'perennial', 'library', 'resting'),
    ]
    const result = evaluatePortfolioProposals('dormancy', portfolio, STEWARD, db, END_DAY)
    expect(result?.evidence).toBe('not_observed')
    expect(getActiveProposal(STEWARD, db)).toBeDefined()
    expect(db.select().from(climateProposals).all()[0].status).toBe('active')
  })

  it('a fully observed, aligned core is a reversal', () => {
    activeCoreProposal()
    seed('org/core-a', 'resting', 14)
    seed('org/app-b', 'resting', 14)

    const portfolio = [
      repo('org/core-a', 'perennial', 'infrastructure', 'resting'),
      repo('org/app-b', 'perennial', 'application', 'resting'),
    ]
    const result = evaluatePortfolioProposals('dormancy', portfolio, STEWARD, db, END_DAY)
    expect(result).toBeUndefined()
    expect(db.select().from(climateProposals).all()[0].status).toBe('withdrawn')
  })

  it('a core repository that still diverges supports the proposal even if another core repository is unobserved', () => {
    activeCoreProposal()
    seed('org/core-a', 'expanding', 14) // divergent from dormancy, fully observed
    seed('org/core-b', 'resting', 3) // insufficient

    const portfolio = [
      repo('org/core-a', 'perennial', 'infrastructure', 'expanding'),
      repo('org/core-b', 'perennial', 'infrastructure', 'resting'),
    ]
    const result = evaluatePortfolioProposals('dormancy', portfolio, STEWARD, db, END_DAY)
    expect(result?.evidence).toBe('supported')
  })
})
