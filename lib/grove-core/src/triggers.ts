import type {
  Climate,
  EcosystemTriggerResult,
  PersistenceAssessment,
  RepoPersistenceContext,
  RepositoryEcology,
  Season,
} from './types'
import { classifyRepository, deriveClimateRelation } from './ecosystem-balance'
import { PERSISTENCE_WINDOW_SIZE } from './persistence'

/**
 * Build a RepoPersistenceContext from a repository, its persistence assessment,
 * and the declared climate.
 *
 * Returns undefined if the repo is unclassified (missing horizon or role).
 * Seasonal repos return a context with stratum = undefined — observed but
 * non-triggering per §3.
 *
 * divergentSeason is only set when persistence flags divergent AND the repo's
 * current season actually diverges from the declared climate. This prevents
 * stale or inconsistent persistence data from producing false direction claims.
 */
export function buildRepoPersistenceContext(
  repo: RepositoryEcology,
  persistence: PersistenceAssessment,
  climate: Climate,
): RepoPersistenceContext | undefined {
  const classification = classifyRepository(repo)
  if (!classification) return undefined

  let divergentSeason: Season | undefined
  if (persistence.persistentlyDivergent && repo.season) {
    const relation = deriveClimateRelation(repo.season.season, climate)
    if (relation === 'divergent') {
      divergentSeason = repo.season.season
    }
  }

  return {
    fullName: repo.fullName,
    stratum: classification.stratum,
    persistence,
    divergentSeason,
  }
}

/**
 * §5 — Evaluate ecosystem balance triggers from pre-built persistence contexts.
 *
 * Partitions contexts by stratum and evaluates:
 * - §5.1 Core Divergence — at least one Set A repo is persistently divergent
 * - §5.2 Core Split — Set A has both persistently aligned and persistently divergent repos
 * - §5.3 Long-Arc Drift — ≥2 Set B repos are persistently divergent in the same direction
 *
 * Contexts with stratum = undefined (seasonal repos) and Set C (ephemeral_field)
 * are collected but do not independently trigger observations.
 */
export function evaluateEcosystemTriggers(
  contexts: RepoPersistenceContext[],
): EcosystemTriggerResult {
  // Defense-in-depth: only contexts whose window spans the full 14 calendar
  // days and carries enough observed days to reach the threshold take part.
  // Insufficient windows should never have persistentlyAligned/Divergent set
  // (assessPersistence guards this); enforced here against malformed contexts.
  const valid = contexts.filter(
    (ctx) =>
      ctx.persistence.windowDays >= PERSISTENCE_WINDOW_SIZE &&
      ctx.persistence.evidence !== 'insufficient',
  )

  // Partition by stratum
  const setA: RepoPersistenceContext[] = []
  const setB: RepoPersistenceContext[] = []

  for (const ctx of valid) {
    if (ctx.stratum === 'structural_core') setA.push(ctx)
    else if (ctx.stratum === 'long_arc_domain') setB.push(ctx)
    // ephemeral_field (Set C) and undefined (seasonal) — collected but non-triggering
  }

  // §5.1 — Core Divergence
  const coreDivergence = setA.filter(
    (ctx) => ctx.persistence.persistentlyDivergent,
  )

  // §5.2 — Core Split
  const hasAligned = setA.some((ctx) => ctx.persistence.persistentlyAligned)
  const hasDivergent = coreDivergence.length > 0
  const coreSplit = hasAligned && hasDivergent

  // §5.3 — Long-Arc Drift
  const longArcDrift = evaluateLongArcDrift(setB)

  const triggered =
    coreDivergence.length > 0 || coreSplit || longArcDrift.repos.length > 0

  return {
    coreDivergence,
    coreSplit,
    longArcDrift,
    triggered,
  }
}

/**
 * §5.3 — Evaluate Long-Arc Drift within Set B.
 *
 * Filters for persistently divergent repos, then checks if ≥2 share the same
 * divergent season (directional coherence). When multiple seasons have ≥2 repos,
 * takes the largest coherent group. Ties are broken alphabetically by season
 * name for deterministic output regardless of input ordering.
 */
function evaluateLongArcDrift(setB: RepoPersistenceContext[]): {
  repos: RepoPersistenceContext[]
  coherentSeason?: Season
} {
  const divergent = setB.filter(
    (ctx) => ctx.persistence.persistentlyDivergent,
  )

  if (divergent.length < 2) {
    return { repos: [] }
  }

  // Group by divergent season
  const byDirection = new Map<Season, RepoPersistenceContext[]>()
  for (const ctx of divergent) {
    if (ctx.divergentSeason) {
      const group = byDirection.get(ctx.divergentSeason) ?? []
      group.push(ctx)
      byDirection.set(ctx.divergentSeason, group)
    }
  }

  // Find the largest coherent group with ≥2 repos.
  // Ties broken alphabetically by season for deterministic output.
  let bestGroup: RepoPersistenceContext[] = []
  let bestSeason: Season | undefined

  for (const [season, group] of byDirection) {
    if (
      group.length >= 2 &&
      (group.length > bestGroup.length ||
        (group.length === bestGroup.length &&
          bestSeason !== undefined &&
          season < bestSeason))
    ) {
      bestGroup = group
      bestSeason = season
    }
  }

  if (bestGroup.length >= 2) {
    return { repos: bestGroup, coherentSeason: bestSeason }
  }

  return { repos: [] }
}
