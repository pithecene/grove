import { describe, expect, it } from 'vitest'

import { assessProposalEvidence } from '../proposals'
import type {
  ClimateProposal,
  EcosystemTriggerResult,
  RepoPersistenceContext,
} from '../types'

function divergentCore(
  name: string,
  season: 'expansion' | 'pruning',
): RepoPersistenceContext {
  return {
    fullName: name,
    stratum: 'structural_core',
    persistence: {
      alignedCount: 0,
      divergentCount: 10,
      orthogonalCount: 0,
      undeterminedCount: 0,
      totalSnapshots: 14,
      windowDays: 14,
      missingDays: 0,
      evidence: 'complete',
      persistentlyAligned: false,
      persistentlyDivergent: true,
    },
    divergentSeason: season,
  }
}

const proposal: ClimateProposal = {
  climate: 'expansion',
  basis: 'sustained_core_divergence',
  triggerType: 'core_divergence',
  observedSeason: 'expansion',
}

function triggers(core: RepoPersistenceContext[]): EcosystemTriggerResult {
  return {
    coreDivergence: core,
    coreSplit: false,
    longArcDrift: { repos: [] },
    triggered: core.length > 0,
  }
}

describe('assessProposalEvidence', () => {
  it('no current evidence → not_observed (never a reversal)', () => {
    expect(assessProposalEvidence(proposal, undefined)).toBe('not_observed')
  })

  it('current window reproduces the pattern → supported', () => {
    expect(
      assessProposalEvidence(proposal, triggers([divergentCore('a/x', 'expansion')])),
    ).toBe('supported')
  })

  it('current window has evidence and the pattern is absent → reversed', () => {
    expect(assessProposalEvidence(proposal, triggers([]))).toBe('reversed')
  })

  it('current window has evidence and the direction changed → reversed', () => {
    expect(
      assessProposalEvidence(proposal, triggers([divergentCore('a/x', 'pruning')])),
    ).toBe('reversed')
  })
})
