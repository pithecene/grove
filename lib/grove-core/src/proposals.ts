import type {
  Climate,
  ClimateProposal,
  EcosystemTriggerResult,
  ProposalEvidenceState,
  RepoPersistenceContext,
  Season,
} from './types'

/**
 * §2.3 — Minimum snapshot history (days) required before Grove may propose.
 * 21 days ensures at least one full 14-day window plus a partial second window.
 */
export const PROPOSAL_MIN_HISTORY_DAYS = 21

/**
 * §2.3 — Minimum portfolio size required before Grove may propose.
 */
export const PROPOSAL_MIN_REPOS = 3

/**
 * §5.4 — Evaluate whether a climate proposal should be generated.
 *
 * Requires two consecutive 14-day windows (~28 days) of sustained trigger.
 * Takes the current window result and the prior window result.
 *
 * Returns a ClimateProposal if:
 * - Both windows have the same trigger type firing
 * - Proposal constraints (§2.3) are met
 * - A coherent climate direction can be identified
 *
 * Returns undefined if escalation conditions are not met.
 */
export function evaluateClimateProposal(
  currentTriggers: EcosystemTriggerResult,
  priorTriggers: EcosystemTriggerResult,
  constraints: ProposalConstraints,
): ClimateProposal | undefined {
  if (!currentTriggers.triggered || !priorTriggers.triggered) return undefined
  if (!meetsProposalConstraints(constraints)) return undefined

  // §5.2 — Core Split persists across both windows
  if (currentTriggers.coreSplit && priorTriggers.coreSplit) {
    // Core split means the portfolio is pulled in multiple directions.
    // This is a "mixed_transition" — no single season dominates the core.
    // No coherent climate to propose from a split.
    return undefined
  }

  // §5.1 — Core Divergence persists across both windows in the same direction
  if (
    currentTriggers.coreDivergence.length > 0 &&
    priorTriggers.coreDivergence.length > 0
  ) {
    const currentSeason = findCoherentDivergentSeason(currentTriggers.coreDivergence)
    const priorSeason = findCoherentDivergentSeason(priorTriggers.coreDivergence)
    // Both windows must have a coherent season AND they must match —
    // a shift from pruning to expansion between windows is not persistence.
    if (currentSeason && priorSeason && currentSeason === priorSeason) {
      return {
        climate: currentSeason as Climate,
        basis: 'sustained_core_divergence',
        triggerType: 'core_divergence',
        observedSeason: currentSeason,
      }
    }
  }

  // §5.3 — Long-Arc Drift persists across both windows in the same direction
  if (
    currentTriggers.longArcDrift.repos.length > 0 &&
    priorTriggers.longArcDrift.repos.length > 0
  ) {
    const currentSeason = currentTriggers.longArcDrift.coherentSeason
    const priorSeason = priorTriggers.longArcDrift.coherentSeason
    // Both windows must have a coherent season AND they must match.
    if (currentSeason && priorSeason && currentSeason === priorSeason) {
      return {
        climate: currentSeason as Climate,
        basis: 'long_arc_alignment',
        triggerType: 'long_arc_drift',
        observedSeason: currentSeason,
      }
    }
  }

  return undefined
}

/**
 * §2.3 — Validate proposal constraints.
 */
export interface ProposalConstraints {
  /** Total days of snapshot history available */
  historyDays: number
  /** Total classified repos in portfolio */
  classifiedRepoCount: number
  /** Whether at least one Set A (structural core) repo exists */
  hasSetA: boolean
}

export function meetsProposalConstraints(constraints: ProposalConstraints): boolean {
  return (
    constraints.historyDays >= PROPOSAL_MIN_HISTORY_DAYS &&
    constraints.classifiedRepoCount >= PROPOSAL_MIN_REPOS &&
    constraints.hasSetA
  )
}

/**
 * Extract a coherent divergent season from a set of divergent repos.
 * Returns the season if all divergent repos share the same direction,
 * undefined if directions are mixed.
 */
function findCoherentDivergentSeason(
  contexts: RepoPersistenceContext[],
): Season | undefined {
  const seasons = new Set<Season>()
  for (const ctx of contexts) {
    if (ctx.divergentSeason) seasons.add(ctx.divergentSeason)
  }
  if (seasons.size === 1) {
    return [...seasons][0]
  }
  return undefined
}

/**
 * §5.4 — Generate escalated observation language for sustained trigger conditions.
 *
 * Used when triggers have persisted across two consecutive windows but
 * a proposal may or may not have been generated. Strengthens tone
 * while remaining non-prescriptive.
 */
export function escalatedObservation(
  proposal: ClimateProposal,
  climate: Climate,
): string {
  switch (proposal.triggerType) {
    case 'core_divergence':
      return `Structural core projects have sustained a ${proposal.observedSeason} seasonal pattern over an extended observation period, diverging from the declared ${climate} climate. This persistent tension may invite reflection on the portfolio's declared climate.`
    case 'core_split':
      return `The structural core has maintained an internal seasonal split over an extended observation period. Projects within the core are pulled between alignment with the declared ${climate} climate and divergent seasonal directions.`
    case 'long_arc_drift':
      return `Long-horizon domain projects have sustained a coherent ${proposal.observedSeason} seasonal direction over an extended observation period, diverging from the declared ${climate} climate. This persistent directional pattern may invite reflection on the portfolio's declared climate.`
  }
}

/**
 * Determine whether an existing proposal should be withdrawn.
 *
 * §2.3 — Grove must withdraw a proposal if the underlying pattern reverses.
 * A pattern has reversed when:
 * - The trigger type that generated the proposal no longer fires, OR
 * - The trigger still fires but the observed direction has changed
 *   (e.g., divergence shifted from pruning to expansion)
 */
/**
 * §2.3 — Relate a standing proposal to the current evaluation window.
 *
 * - `supported`: the window carried enough evidence and reproduces the pattern.
 * - `reversed`: the window carried enough evidence and the pattern is absent
 *   or has changed direction — the proposal is to be withdrawn.
 * - `not_observed`: the window did not carry enough observed days to
 *   re-examine the pattern (`currentTriggers` is undefined), or the
 *   repositories that could carry the pattern were not all observed enough
 *   (`sourceEvidenceComplete` is false) while the pattern did not fire.
 *   Missing evidence is not a reversal: the proposal stands, unchanged, and
 *   is not presented as freshly supported.
 *
 * `sourceEvidenceComplete` says whether every repository in the stratum the
 * proposal's trigger draws on (Set A for core divergence / split, Set B for
 * long-arc drift) had sufficient evidence in the current window. Evidence
 * from unrelated repositories never turns an unobserved pattern into a
 * reversal.
 */
export function assessProposalEvidence(
  proposal: ClimateProposal,
  currentTriggers: EcosystemTriggerResult | undefined,
  sourceEvidenceComplete = true,
): ProposalEvidenceState {
  if (!currentTriggers) return 'not_observed'
  if (!shouldWithdrawProposal(proposal, currentTriggers)) return 'supported'
  return sourceEvidenceComplete ? 'reversed' : 'not_observed'
}

/** The stratum a proposal's trigger draws its evidence from. */
export function proposalSourceStratum(
  proposal: ClimateProposal,
): 'structural_core' | 'long_arc_domain' {
  return proposal.triggerType === 'long_arc_drift' ? 'long_arc_domain' : 'structural_core'
}

export function shouldWithdrawProposal(
  proposal: ClimateProposal,
  currentTriggers: EcosystemTriggerResult,
): boolean {
  if (!currentTriggers.triggered) return true

  switch (proposal.triggerType) {
    case 'core_divergence': {
      if (currentTriggers.coreDivergence.length === 0) return true
      // Withdraw if the divergent direction has changed
      if (proposal.observedSeason) {
        const currentSeason = findCoherentDivergentSeason(currentTriggers.coreDivergence)
        if (currentSeason !== proposal.observedSeason) return true
      }
      return false
    }
    case 'core_split':
      return !currentTriggers.coreSplit
    case 'long_arc_drift': {
      if (currentTriggers.longArcDrift.repos.length === 0) return true
      // Withdraw if the coherent drift direction has changed
      if (proposal.observedSeason) {
        if (currentTriggers.longArcDrift.coherentSeason !== proposal.observedSeason) {
          return true
        }
      }
      return false
    }
  }
}
