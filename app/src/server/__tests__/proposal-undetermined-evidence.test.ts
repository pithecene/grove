import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { getActiveProposal, persistProposal } from '../db'
import { createDb, type GroveDb } from '../db/client'
import { climateProposals, ecologySnapshots, repositories } from '../db/schema'
import {
  evaluatePortfolioEcosystemTriggers,
  evaluatePortfolioProposals,
  type TriggerSubject,
} from '../ecosystem-triggers'

let db: GroveDb

beforeEach(() => {
  db = createDb(new Database(':memory:'))
})

const END_DAY = '2025-01-14'
const STEWARD = 7

const core: TriggerSubject = {
  fullName: 'org/core',
  htmlUrl: 'https://github.com/org/core',
  classified: true,
  declaration: { intent: 'test', horizon: 'perennial', role: 'infrastructure' },
}

/** Snapshots observed every day but with no phase recorded — relation underivable. */
function seedUndetermined(fullName: string, count: number) {
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
        observedAt: `2025-01-${String(1 + i).padStart(2, '0')}T12:00:00Z`,
        classified: true,
        phase: null,
      })
      .run()
  }
}

describe('undetermined relations are ambiguity, not evidence', () => {
  it('triggers are not evaluated from windows whose relations cannot be derived', () => {
    seedUndetermined('org/core', 14)
    expect(
      evaluatePortfolioEcosystemTriggers('dormancy', [core], db, END_DAY),
    ).toBeUndefined()
  })

  it('a standing proposal is kept as not observed, never withdrawn, on undetermined windows', () => {
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
    seedUndetermined('org/core', 14)
    const result = evaluatePortfolioProposals('dormancy', [core], STEWARD, db, END_DAY)
    expect(result?.evidence).toBe('not_observed')
    expect(getActiveProposal(STEWARD, db)).toBeDefined()
    expect(db.select().from(climateProposals).all()[0].status).toBe('active')
  })
})
