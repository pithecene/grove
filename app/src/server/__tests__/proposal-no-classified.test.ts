import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import { getActiveProposal, persistProposal } from '../db'
import { createDb } from '../db/client'
import { evaluatePortfolioProposals } from '../ecosystem-triggers'

describe('a standing proposal survives a portfolio with no classified repositories', () => {
  it('is returned as not observed and stays active', () => {
    const db = createDb(new Database(':memory:'))
    persistProposal(
      {
        climate: 'expansion',
        basis: 'sustained_core_divergence',
        triggerType: 'core_divergence',
        observedSeason: 'expansion',
      },
      'synthetic',
      7,
      db,
    )
    const unclassified = {
      fullName: 'org/nogrove',
      htmlUrl: 'https://github.com/org/nogrove',
      classified: false,
    }
    const result = evaluatePortfolioProposals(
      'dormancy',
      [unclassified],
      7,
      db,
      '2025-01-14',
    )
    expect(result).toMatchObject({ climate: 'expansion', evidence: 'not_observed' })
    expect(getActiveProposal(7, db)?.status).toBe('active')
  })
})
