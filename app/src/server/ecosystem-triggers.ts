import type {
  CalendarSlot,
  Climate,
  ClimateProposal,
  EcosystemTriggerResult,
  RepoPersistenceContext,
  RepositoryEcology,
} from '@grove/core'
import {
  assessPersistence,
  assessProposalEvidence,
  buildRepoPersistenceContext,
  classifyRepository,
  escalatedObservation,
  evaluateClimateProposal,
  evaluateEcosystemTriggers,
  hasDeterminateEvidence,
  PERSISTENCE_WINDOW_SIZE,
  proposalSourceStratum,
  relateCalendarWindow,
  toUtcDay,
} from '@grove/core'
import type {
  GroveDb,
  ProposalSource,
  SnapshotRow,
  StoredProposal,
  WindowSubject,
} from './db'
import {
  getActiveProposal,
  getPortfolioCalendarWindow,
  markProposalSupported,
  parseProposalSources,
  persistProposal,
  withdrawActiveProposal,
} from './db'

/** A classified repository plus, when known, its immutable identity. */
export type TriggerSubject = RepositoryEcology & { githubId?: number }

/** §5.4 — Two consecutive windows for escalation evaluation. */
const ESCALATION_WINDOW_SIZE = PERSISTENCE_WINDOW_SIZE * 2

function todayUtc(): string {
  return toUtcDay(new Date().toISOString())
}

function toSubjects(repos: TriggerSubject[]): WindowSubject[] {
  return repos.map((r) => ({ fullName: r.fullName, githubId: r.githubId }))
}

function buildContexts(
  classified: TriggerSubject[],
  windows: Map<string, CalendarSlot<SnapshotRow>[]>,
  climate: Climate,
): RepoPersistenceContext[] {
  return classified
    .map((repo) => {
      const slots = windows.get(repo.fullName) ?? []
      const persistence = assessPersistence(relateCalendarWindow(slots, climate))
      return buildRepoPersistenceContext(repo, persistence, climate)
    })
    .filter((ctx): ctx is NonNullable<typeof ctx> => ctx !== undefined)
}

/** True when at least one window carries enough determinate observations to be examined. */
function hasEvidence(contexts: RepoPersistenceContext[]): boolean {
  return contexts.some((ctx) => hasDeterminateEvidence(ctx.persistence))
}

/**
 * Orchestrate the snapshot → trigger pipeline for a portfolio over the
 * 14 calendar days ending at `endDay` (today by default).
 *
 * Returns undefined when triggers cannot be meaningfully evaluated:
 * - No declared climate (§5 requires it)
 * - No classified repos
 * - No repo's window carries enough observed days (a long absence yields
 *   a window of empty slots, which is "not observed", never "no tension")
 *
 * A defined result (even with triggered: false) means the pipeline ran
 * with sufficient evidence and its outcome is authoritative.
 */
export function evaluatePortfolioEcosystemTriggers(
  climate: Climate | undefined,
  repositories: TriggerSubject[],
  db?: GroveDb,
  endDay: string = todayUtc(),
): EcosystemTriggerResult | undefined {
  if (!climate) return undefined

  const classified = repositories.filter((r) => r.classified)
  if (classified.length === 0) return undefined

  const windows = db
    ? getPortfolioCalendarWindow(
        toSubjects(classified),
        endDay,
        PERSISTENCE_WINDOW_SIZE,
        db,
      )
    : getPortfolioCalendarWindow(toSubjects(classified), endDay, PERSISTENCE_WINDOW_SIZE)

  const contexts = buildContexts(classified, windows, climate)
  if (!hasEvidence(contexts)) return undefined

  return evaluateEcosystemTriggers(contexts)
}

/**
 * §5.4 — Evaluate climate proposal escalation for a portfolio.
 *
 * Builds one 28-day calendar window per repo, splits it into the current
 * (days 1–14) and prior (days 15–28) windows, and evaluates triggers on
 * each only where enough days were observed.
 *
 * Proposal lifecycle, by evidence:
 * - supported   — the current window reproduces the pattern; `last_supported_at` advances.
 * - reversed    — the current window has evidence and the pattern is absent or changed; withdrawn.
 * - not_observed — the current window lacks evidence; the proposal stands
 *   untouched and is surfaced as such, not as freshly validated.
 *
 * A new proposal needs evidence in both windows, the same trigger in both,
 * and the §2.3 constraints (history measured in observed days within the
 * 28-day window).
 *
 * Returns the active proposal (existing or new), or undefined.
 */
export function evaluatePortfolioProposals(
  climate: Climate,
  repositories: TriggerSubject[],
  stewardId: number,
  db?: GroveDb,
  endDay: string = todayUtc(),
): ClimateProposal | undefined {
  const classified = repositories.filter((r) => r.classified)
  if (classified.length === 0) {
    // Nothing to evaluate against, but a standing proposal is not thereby
    // reversed: it stays visible as not observed.
    const standing = getActiveProposal(stewardId, db)
    return standing
      ? { ...toClimateProposal(standing), evidence: 'not_observed' }
      : undefined
  }

  const fullWindows = db
    ? getPortfolioCalendarWindow(
        toSubjects(classified),
        endDay,
        ESCALATION_WINDOW_SIZE,
        db,
      )
    : getPortfolioCalendarWindow(toSubjects(classified), endDay, ESCALATION_WINDOW_SIZE)

  const currentWindows = new Map<string, CalendarSlot<SnapshotRow>[]>()
  const priorWindows = new Map<string, CalendarSlot<SnapshotRow>[]>()
  let observedDays = 0
  for (const [name, slots] of fullWindows) {
    currentWindows.set(name, slots.slice(0, PERSISTENCE_WINDOW_SIZE))
    priorWindows.set(name, slots.slice(PERSISTENCE_WINDOW_SIZE, ESCALATION_WINDOW_SIZE))
    const observed = slots.filter((s) => s.snapshot !== undefined).length
    if (observed > observedDays) observedDays = observed
  }

  const currentContexts = buildContexts(classified, currentWindows, climate)
  const priorContexts = buildContexts(classified, priorWindows, climate)

  const currentTriggers = hasEvidence(currentContexts)
    ? evaluateEcosystemTriggers(currentContexts)
    : undefined
  const priorTriggers = hasEvidence(priorContexts)
    ? evaluateEcosystemTriggers(priorContexts)
    : undefined

  const now = new Date().toISOString()

  // Existing proposal: relate it to the current window's evidence. Only the
  // repositories the proposal drew on can confirm or refute it; a reversal
  // needs every one of them present and observed enough, otherwise the
  // pattern is simply not observed this window.
  const existing = getActiveProposal(stewardId, db)
  if (existing) {
    const proposal = toClimateProposal(existing)
    const source = matchSourceContexts(
      parseProposalSources(existing.sourceRepositories),
      proposal,
      currentContexts,
      classified,
    )
    // The pattern is re-examined among the recorded sources only: a trigger
    // carried by repositories the proposal never drew on does not support it.
    const sourceTriggers = hasEvidence(source.contexts)
      ? evaluateEcosystemTriggers(source.contexts)
      : undefined
    const evidence = assessProposalEvidence(proposal, sourceTriggers, source.complete)
    if (evidence === 'reversed') {
      withdrawActiveProposal(stewardId, db)
    } else if (evidence === 'supported') {
      markProposalSupported(existing.id, now, db)
      return { ...proposal, lastSupportedAt: now, evidence: 'supported' }
    } else {
      return { ...proposal, evidence: 'not_observed' }
    }
  }

  // New proposal requires evidence in both consecutive windows.
  if (!currentTriggers || !priorTriggers) return undefined

  // §2.3 constraints
  const hasSetA = classified.some(
    (r) => classifyRepository(r)?.stratum === 'structural_core',
  )
  const proposal = evaluateClimateProposal(currentTriggers, priorTriggers, {
    historyDays: observedDays,
    classifiedRepoCount: classified.length,
    hasSetA,
  })
  if (!proposal) return undefined

  const observation = escalatedObservation(proposal, climate)
  persistProposal(
    proposal,
    observation,
    stewardId,
    db,
    proposalSources(proposal, currentTriggers, currentContexts, classified),
  )
  return { ...proposal, lastSupportedAt: now, evidence: 'supported' }
}

function identityByName(classified: TriggerSubject[]): Map<string, number | undefined> {
  return new Map(classified.map((r) => [r.fullName, r.githubId]))
}

/** The repositories whose persistence the trigger behind a proposal drew on. */
function proposalSources(
  proposal: ClimateProposal,
  triggers: EcosystemTriggerResult,
  contexts: RepoPersistenceContext[],
  classified: TriggerSubject[],
): ProposalSource[] {
  const ids = identityByName(classified)
  let names: string[]
  switch (proposal.triggerType) {
    case 'core_divergence':
      names = triggers.coreDivergence.map((c) => c.fullName)
      break
    case 'core_split':
      names = contexts
        .filter(
          (c) =>
            c.stratum === 'structural_core' &&
            (c.persistence.persistentlyAligned || c.persistence.persistentlyDivergent),
        )
        .map((c) => c.fullName)
      break
    case 'long_arc_drift':
      names = triggers.longArcDrift.repos.map((c) => c.fullName)
      break
  }
  return names.map((fullName) => {
    const githubId = ids.get(fullName)
    return githubId !== undefined ? { fullName, githubId } : { fullName }
  })
}

interface SourceMatch {
  /** Current contexts of the repositories the proposal drew on, where present. */
  contexts: RepoPersistenceContext[]
  /** Every source is present in the portfolio and observed enough to be determinate. */
  complete: boolean
}

/**
 * Match a proposal's recorded sources to the current portfolio (by identity
 * when known, else by name). Proposals recorded before sources were tracked
 * fall back to the stratum their trigger draws on.
 */
function matchSourceContexts(
  sources: ProposalSource[] | undefined,
  proposal: ClimateProposal,
  contexts: RepoPersistenceContext[],
  classified: TriggerSubject[],
): SourceMatch {
  if (sources && sources.length > 0) {
    const ids = identityByName(classified)
    const present = sources.flatMap((src) => {
      // A source recorded with its identity is matched by identity only: a
      // reused name is a different repository, not the proposal's source.
      const ctx = contexts.find((c) =>
        src.githubId !== undefined
          ? ids.get(c.fullName) === src.githubId
          : c.fullName === src.fullName,
      )
      return ctx ? [ctx] : []
    })
    return {
      contexts: present,
      complete:
        present.length === sources.length &&
        present.every((ctx) => hasDeterminateEvidence(ctx.persistence)),
    }
  }
  const stratum = proposalSourceStratum(proposal)
  const source = contexts.filter((ctx) => ctx.stratum === stratum)
  return {
    contexts: source,
    complete:
      source.length > 0 && source.every((ctx) => hasDeterminateEvidence(ctx.persistence)),
  }
}

/**
 * Convert a stored proposal row to a ClimateProposal.
 */
function toClimateProposal(stored: StoredProposal): ClimateProposal {
  return {
    climate: stored.climate,
    basis: stored.basis,
    triggerType: stored.triggerType as ClimateProposal['triggerType'],
    observedSeason: (stored.observedSeason as Climate | null) ?? undefined,
    lastSupportedAt: stored.lastSupportedAt ?? undefined,
  }
}
