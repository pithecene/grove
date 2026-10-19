import { describe, expect, it } from 'vitest'

import { assessProposalEvidence, proposalSourceStratum } from '../proposals'
import type { ClimateProposal, EcosystemTriggerResult } from '../types'

const notTriggered: EcosystemTriggerResult = {
  coreDivergence: [],
  coreSplit: false,
  longArcDrift: { repos: [] },
  triggered: false,
}

const core: ClimateProposal = {
  climate: 'expansion',
  basis: 'sustained_core_divergence',
  triggerType: 'core_divergence',
  observedSeason: 'expansion',
}

const longArc: ClimateProposal = {
  climate: 'pruning',
  basis: 'long_arc_alignment',
  triggerType: 'long_arc_drift',
  observedSeason: 'pruning',
}

describe('assessProposalEvidence with incomplete source evidence', () => {
  it('an absent pattern is a reversal only when the source stratum was fully observed', () => {
    expect(assessProposalEvidence(core, notTriggered, true)).toBe('reversed')
    expect(assessProposalEvidence(core, notTriggered, false)).toBe('not_observed')
  })

  it('a present pattern is supported regardless of other repositories', () => {
    const triggered: EcosystemTriggerResult = {
      ...notTriggered,
      triggered: true,
      coreDivergence: [
        {
          fullName: 'a/x',
          stratum: 'structural_core',
          divergentSeason: 'expansion',
          persistence: {
            alignedCount: 0,
            divergentCount: 9,
            orthogonalCount: 0,
            undeterminedCount: 0,
            totalSnapshots: 9,
            windowDays: 14,
            missingDays: 5,
            evidence: 'partial',
            persistentlyAligned: false,
            persistentlyDivergent: true,
          },
        },
      ],
    }
    expect(assessProposalEvidence(core, triggered, false)).toBe('supported')
  })
})

describe('proposalSourceStratum', () => {
  it('maps core divergence and split to the structural core', () => {
    expect(proposalSourceStratum(core)).toBe('structural_core')
    expect(proposalSourceStratum({ ...core, triggerType: 'core_split' })).toBe(
      'structural_core',
    )
  })

  it('maps long-arc drift to the long-arc domain', () => {
    expect(proposalSourceStratum(longArc)).toBe('long_arc_domain')
  })
})
