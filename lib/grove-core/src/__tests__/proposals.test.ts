import { describe, expect, it } from 'vitest'

import {
  escalatedObservation,
  evaluateClimateProposal,
  meetsProposalConstraints,
  PROPOSAL_MIN_HISTORY_DAYS,
  PROPOSAL_MIN_REPOS,
  shouldWithdrawProposal,
} from '../proposals'
import type {
  ClimateProposal,
  EcosystemTriggerResult,
  RepoPersistenceContext,
} from '../types'

// --- Helpers ---

function makePersistenceContext(
  fullName: string,
  opts: {
    stratum?: 'structural_core' | 'long_arc_domain' | 'ephemeral_field'
    persistentlyAligned?: boolean
    persistentlyDivergent?: boolean
    divergentSeason?: 'expansion' | 'consolidation' | 'pruning' | 'dormancy'
  } = {},
): RepoPersistenceContext {
  return {
    fullName,
    stratum: opts.stratum,
    persistence: {
      alignedCount: opts.persistentlyAligned ? 10 : 0,
      divergentCount: opts.persistentlyDivergent ? 10 : 0,
      orthogonalCount: 0,
      undeterminedCount: 0,
      totalSnapshots: 14,
      windowDays: 14,
      missingDays: 0,
      evidence: 'complete',
      persistentlyAligned: opts.persistentlyAligned ?? false,
      persistentlyDivergent: opts.persistentlyDivergent ?? false,
    },
    divergentSeason: opts.divergentSeason,
  }
}

function makeTriggered(overrides: Partial<EcosystemTriggerResult> = {}): EcosystemTriggerResult {
  return {
    coreDivergence: [],
    coreSplit: false,
    longArcDrift: { repos: [] },
    triggered: true,
    ...overrides,
  }
}

function makeNotTriggered(): EcosystemTriggerResult {
  return {
    coreDivergence: [],
    coreSplit: false,
    longArcDrift: { repos: [] },
    triggered: false,
  }
}

const VALID_CONSTRAINTS = {
  historyDays: 28,
  classifiedRepoCount: 5,
  hasSetA: true,
}

// --- Tests ---

describe('meetsProposalConstraints', () => {
  it('passes with all constraints met', () => {
    expect(meetsProposalConstraints(VALID_CONSTRAINTS)).toBe(true)
  })

  it('rejects insufficient history', () => {
    expect(
      meetsProposalConstraints({
        ...VALID_CONSTRAINTS,
        historyDays: PROPOSAL_MIN_HISTORY_DAYS - 1,
      }),
    ).toBe(false)
  })

  it('rejects insufficient repos', () => {
    expect(
      meetsProposalConstraints({
        ...VALID_CONSTRAINTS,
        classifiedRepoCount: PROPOSAL_MIN_REPOS - 1,
      }),
    ).toBe(false)
  })

  it('rejects missing Set A', () => {
    expect(
      meetsProposalConstraints({
        ...VALID_CONSTRAINTS,
        hasSetA: false,
      }),
    ).toBe(false)
  })

  it('accepts exactly at thresholds', () => {
    expect(
      meetsProposalConstraints({
        historyDays: PROPOSAL_MIN_HISTORY_DAYS,
        classifiedRepoCount: PROPOSAL_MIN_REPOS,
        hasSetA: true,
      }),
    ).toBe(true)
  })
})

describe('evaluateClimateProposal', () => {
  it('returns undefined when current triggers have not fired', () => {
    expect(
      evaluateClimateProposal(
        makeNotTriggered(),
        makeTriggered(),
        VALID_CONSTRAINTS,
      ),
    ).toBeUndefined()
  })

  it('returns undefined when prior triggers have not fired', () => {
    expect(
      evaluateClimateProposal(
        makeTriggered(),
        makeNotTriggered(),
        VALID_CONSTRAINTS,
      ),
    ).toBeUndefined()
  })

  it('returns undefined when constraints are not met', () => {
    const ctx = makePersistenceContext('org/core', {
      stratum: 'structural_core',
      persistentlyDivergent: true,
      divergentSeason: 'expansion',
    })
    const triggers = makeTriggered({ coreDivergence: [ctx] })

    expect(
      evaluateClimateProposal(triggers, triggers, {
        ...VALID_CONSTRAINTS,
        hasSetA: false,
      }),
    ).toBeUndefined()
  })

  it('generates proposal for sustained core divergence', () => {
    const ctx = makePersistenceContext('org/core', {
      stratum: 'structural_core',
      persistentlyDivergent: true,
      divergentSeason: 'expansion',
    })
    const triggers = makeTriggered({ coreDivergence: [ctx] })

    const proposal = evaluateClimateProposal(
      triggers,
      triggers,
      VALID_CONSTRAINTS,
    )

    expect(proposal).toEqual({
      climate: 'expansion',
      basis: 'sustained_core_divergence',
      triggerType: 'core_divergence',
      observedSeason: 'expansion',
    })
  })

  it('returns undefined for core split (mixed directions)', () => {
    const triggers = makeTriggered({ coreSplit: true })

    expect(
      evaluateClimateProposal(triggers, triggers, VALID_CONSTRAINTS),
    ).toBeUndefined()
  })

  it('generates proposal for long-arc drift', () => {
    const ctx1 = makePersistenceContext('org/app1', {
      stratum: 'long_arc_domain',
      persistentlyDivergent: true,
      divergentSeason: 'pruning',
    })
    const ctx2 = makePersistenceContext('org/app2', {
      stratum: 'long_arc_domain',
      persistentlyDivergent: true,
      divergentSeason: 'pruning',
    })
    const triggers = makeTriggered({
      longArcDrift: { repos: [ctx1, ctx2], coherentSeason: 'pruning' },
    })

    const proposal = evaluateClimateProposal(
      triggers,
      triggers,
      VALID_CONSTRAINTS,
    )

    expect(proposal).toEqual({
      climate: 'pruning',
      basis: 'long_arc_alignment',
      triggerType: 'long_arc_drift',
      observedSeason: 'pruning',
    })
  })

  it('returns undefined for core divergence without coherent season', () => {
    const ctx1 = makePersistenceContext('org/core1', {
      stratum: 'structural_core',
      persistentlyDivergent: true,
      divergentSeason: 'expansion',
    })
    const ctx2 = makePersistenceContext('org/core2', {
      stratum: 'structural_core',
      persistentlyDivergent: true,
      divergentSeason: 'pruning',
    })
    const triggers = makeTriggered({ coreDivergence: [ctx1, ctx2] })

    expect(
      evaluateClimateProposal(triggers, triggers, VALID_CONSTRAINTS),
    ).toBeUndefined()
  })

  it('returns undefined when core divergence direction changed between windows', () => {
    const currentCtx = makePersistenceContext('org/core', {
      stratum: 'structural_core',
      persistentlyDivergent: true,
      divergentSeason: 'expansion',
    })
    const priorCtx = makePersistenceContext('org/core', {
      stratum: 'structural_core',
      persistentlyDivergent: true,
      divergentSeason: 'pruning',
    })
    const currentTriggers = makeTriggered({ coreDivergence: [currentCtx] })
    const priorTriggers = makeTriggered({ coreDivergence: [priorCtx] })

    expect(
      evaluateClimateProposal(currentTriggers, priorTriggers, VALID_CONSTRAINTS),
    ).toBeUndefined()
  })

  it('returns undefined when long-arc drift direction changed between windows', () => {
    const currentCtx = makePersistenceContext('org/app1', {
      stratum: 'long_arc_domain',
      persistentlyDivergent: true,
      divergentSeason: 'expansion',
    })
    const priorCtx = makePersistenceContext('org/app1', {
      stratum: 'long_arc_domain',
      persistentlyDivergent: true,
      divergentSeason: 'dormancy',
    })
    const currentTriggers = makeTriggered({
      longArcDrift: { repos: [currentCtx, currentCtx], coherentSeason: 'expansion' },
    })
    const priorTriggers = makeTriggered({
      longArcDrift: { repos: [priorCtx, priorCtx], coherentSeason: 'dormancy' },
    })

    expect(
      evaluateClimateProposal(currentTriggers, priorTriggers, VALID_CONSTRAINTS),
    ).toBeUndefined()
  })

  it('returns undefined when prior window core divergence has no coherent season', () => {
    const currentCtx = makePersistenceContext('org/core', {
      stratum: 'structural_core',
      persistentlyDivergent: true,
      divergentSeason: 'expansion',
    })
    const priorCtx1 = makePersistenceContext('org/core', {
      stratum: 'structural_core',
      persistentlyDivergent: true,
      divergentSeason: 'expansion',
    })
    const priorCtx2 = makePersistenceContext('org/core2', {
      stratum: 'structural_core',
      persistentlyDivergent: true,
      divergentSeason: 'pruning',
    })
    const currentTriggers = makeTriggered({ coreDivergence: [currentCtx] })
    const priorTriggers = makeTriggered({ coreDivergence: [priorCtx1, priorCtx2] })

    // Prior window has mixed directions → no coherent prior season → no proposal
    expect(
      evaluateClimateProposal(currentTriggers, priorTriggers, VALID_CONSTRAINTS),
    ).toBeUndefined()
  })

  it('prefers core divergence over long-arc drift', () => {
    const coreCtx = makePersistenceContext('org/core', {
      stratum: 'structural_core',
      persistentlyDivergent: true,
      divergentSeason: 'expansion',
    })
    const domainCtx = makePersistenceContext('org/app', {
      stratum: 'long_arc_domain',
      persistentlyDivergent: true,
      divergentSeason: 'pruning',
    })
    const triggers = makeTriggered({
      coreDivergence: [coreCtx],
      longArcDrift: { repos: [domainCtx, domainCtx], coherentSeason: 'pruning' },
    })

    const proposal = evaluateClimateProposal(
      triggers,
      triggers,
      VALID_CONSTRAINTS,
    )

    expect(proposal?.basis).toBe('sustained_core_divergence')
  })
})

describe('shouldWithdrawProposal', () => {
  const coreProposal: ClimateProposal = {
    climate: 'expansion',
    basis: 'sustained_core_divergence',
    triggerType: 'core_divergence',
    observedSeason: 'expansion',
  }

  it('withdraws when triggers no longer fire', () => {
    expect(shouldWithdrawProposal(coreProposal, makeNotTriggered())).toBe(true)
  })

  it('withdraws when core divergence no longer present', () => {
    expect(
      shouldWithdrawProposal(
        coreProposal,
        makeTriggered({ coreDivergence: [] }),
      ),
    ).toBe(true)
  })

  it('keeps proposal when core divergence persists in same direction', () => {
    const ctx = makePersistenceContext('org/core', {
      stratum: 'structural_core',
      persistentlyDivergent: true,
      divergentSeason: 'expansion',
    })
    expect(
      shouldWithdrawProposal(
        coreProposal,
        makeTriggered({ coreDivergence: [ctx] }),
      ),
    ).toBe(false)
  })

  it('withdraws when core divergence direction changes', () => {
    const ctx = makePersistenceContext('org/core', {
      stratum: 'structural_core',
      persistentlyDivergent: true,
      divergentSeason: 'pruning', // proposal was for 'expansion'
    })
    expect(
      shouldWithdrawProposal(
        coreProposal,
        makeTriggered({ coreDivergence: [ctx] }),
      ),
    ).toBe(true)
  })

  it('withdraws when core divergence loses coherent direction', () => {
    const ctx1 = makePersistenceContext('org/core1', {
      stratum: 'structural_core',
      persistentlyDivergent: true,
      divergentSeason: 'expansion',
    })
    const ctx2 = makePersistenceContext('org/core2', {
      stratum: 'structural_core',
      persistentlyDivergent: true,
      divergentSeason: 'pruning',
    })
    // Mixed directions → no coherent season → withdraw
    expect(
      shouldWithdrawProposal(
        coreProposal,
        makeTriggered({ coreDivergence: [ctx1, ctx2] }),
      ),
    ).toBe(true)
  })

  it('withdraws long-arc drift proposal when drift stops', () => {
    const driftProposal: ClimateProposal = {
      climate: 'pruning',
      basis: 'long_arc_alignment',
      triggerType: 'long_arc_drift',
      observedSeason: 'pruning',
    }
    expect(
      shouldWithdrawProposal(
        driftProposal,
        makeTriggered({ longArcDrift: { repos: [] } }),
      ),
    ).toBe(true)
  })

  it('withdraws long-arc drift proposal when direction changes', () => {
    const driftProposal: ClimateProposal = {
      climate: 'pruning',
      basis: 'long_arc_alignment',
      triggerType: 'long_arc_drift',
      observedSeason: 'pruning',
    }
    const ctx = makePersistenceContext('org/app', {
      stratum: 'long_arc_domain',
      persistentlyDivergent: true,
      divergentSeason: 'expansion',
    })
    expect(
      shouldWithdrawProposal(
        driftProposal,
        makeTriggered({
          longArcDrift: { repos: [ctx, ctx], coherentSeason: 'expansion' },
        }),
      ),
    ).toBe(true)
  })

  it('keeps long-arc drift proposal when direction persists', () => {
    const driftProposal: ClimateProposal = {
      climate: 'pruning',
      basis: 'long_arc_alignment',
      triggerType: 'long_arc_drift',
      observedSeason: 'pruning',
    }
    const ctx = makePersistenceContext('org/app', {
      stratum: 'long_arc_domain',
      persistentlyDivergent: true,
      divergentSeason: 'pruning',
    })
    expect(
      shouldWithdrawProposal(
        driftProposal,
        makeTriggered({
          longArcDrift: { repos: [ctx, ctx], coherentSeason: 'pruning' },
        }),
      ),
    ).toBe(false)
  })
})

describe('escalatedObservation', () => {
  it('produces non-prescriptive language for core divergence', () => {
    const proposal: ClimateProposal = {
      climate: 'expansion',
      basis: 'sustained_core_divergence',
      triggerType: 'core_divergence',
      observedSeason: 'expansion',
    }
    const text = escalatedObservation(proposal, 'consolidation')
    expect(text).toContain('expansion')
    expect(text).toContain('consolidation')
    expect(text).toContain('invite reflection')
    expect(text).not.toContain('should')
    expect(text).not.toContain('recommend')
  })

  it('produces non-prescriptive language for long-arc drift', () => {
    const proposal: ClimateProposal = {
      climate: 'pruning',
      basis: 'long_arc_alignment',
      triggerType: 'long_arc_drift',
      observedSeason: 'pruning',
    }
    const text = escalatedObservation(proposal, 'expansion')
    expect(text).toContain('pruning')
    expect(text).toContain('expansion')
    expect(text).toContain('invite reflection')
  })
})
