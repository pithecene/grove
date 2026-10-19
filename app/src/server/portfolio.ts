import type {
  ClimateProposal,
  DensityObservation,
  EcosystemTriggerResult,
  Portfolio,
  RepositoryEcology,
  StructuralSignals,
} from '@grove/core'
import {
  observeConsolidationInterval,
  observeStructuralDensity,
} from '@grove/core'
import {
  classifyRepository,
  fetchStructuralSignals,
  fetchUserRepos,
} from '@grove/github'
import { createServerFn } from '@tanstack/react-start'

import {
  getCurrentClimate,
  recordDeclarationIfChanged,
  recordSnapshotBatch,
  upsertRepositories,
} from './db'
import {
  evaluatePortfolioEcosystemTriggers,
  evaluatePortfolioProposals,
} from './ecosystem-triggers'
import { type AccessFailure, accessFailure } from './github-state'
import { type IdentityUnavailableReason, resolveStewardIdentity } from './identity'
import { applyScope, parseScope } from './scope'

const BATCH_SIZE = 10

/**
 * Load and classify all repositories for the authenticated user.
 * Fetches .grove.yaml concurrently in batches, then enriches
 * classified repos with structural signals and density.
 */
export type PortfolioView = Portfolio & {
  ecosystemTriggers?: EcosystemTriggerResult
  climateProposal?: ClimateProposal
}

/**
 * What a portfolio load produced. Only `observed` carries a portfolio; the
 * other kinds say why nothing was observed. A listing GitHub did not answer
 * is never shown as an empty portfolio, and nothing is recorded for it.
 */
export type PortfolioLookup =
  | { kind: 'observed'; portfolio: PortfolioView }
  /** No steward identity, and why — the same reason the session reports */
  | { kind: 'unauthenticated'; reason: IdentityUnavailableReason }
  | AccessFailure

export const loadPortfolio = createServerFn({ method: 'GET' }).handler(
  async (): Promise<PortfolioLookup> => {
    // Identity first — no token, or no usable answer about it, means nothing
    // to observe; the reason travels with the result.
    const resolution = await resolveStewardIdentity()
    if (resolution.kind === 'unavailable') {
      return { kind: 'unauthenticated', reason: resolution.reason }
    }
    const { identity } = resolution

    const token = identity.token
    // Explicit, private selection of what to observe (GROVE_SCOPE_*).
    // Repositories outside the scope are not enumerated further and nothing
    // previously recorded about them is touched.
    const listing = await fetchUserRepos(token)
    if (listing.kind !== 'ok') return accessFailure(listing, 'the portfolio listing')
    const repos = applyScope(listing.value, parseScope())
    const idByName = new Map(repos.map((r) => [r.full_name, r.id]))

    // Phase 1: Classify in batches
    const classified: RepositoryEcology[] = []
    for (let i = 0; i < repos.length; i += BATCH_SIZE) {
      const batch = repos.slice(i, i + BATCH_SIZE)
      const answers = await Promise.all(
        batch.map((repo) => classifyRepository(token, repo)),
      )
      // One repository GitHub did not answer about is not "unclassified":
      // nothing is recorded for the portfolio this time.
      const failedAt = answers.findIndex((a) => a.kind !== 'ok')
      const failed = answers[failedAt]
      if (failed && failed.kind !== 'ok') {
        return accessFailure(failed, `the declaration of ${batch[failedAt].full_name}`)
      }
      const results = answers.flatMap((a) => (a.kind === 'ok' ? [a.value] : []))
      classified.push(...results)
    }

    // Phase 2: Enrich classified repos with structural signals
    const ecosystemRepoNames = repos.map((r) => r.full_name)
    const reposByName = new Map(repos.map((r) => [r.full_name, r]))

    // Collect only classified repos for signal fetching, preserving indices
    const classifiedIndices: number[] = []
    for (let i = 0; i < classified.length; i++) {
      if (classified[i]!.classified) classifiedIndices.push(i)
    }

    // Fetch signals in batches for classified repos only
    const signalsByName = new Map<string, StructuralSignals>()
    const densityByName = new Map<string, DensityObservation>()

    for (let i = 0; i < classifiedIndices.length; i += BATCH_SIZE) {
      const batchIndices = classifiedIndices.slice(i, i + BATCH_SIZE)
      const signalResults = await Promise.all(
        batchIndices.map((idx) => {
          const ecology = classified[idx]!
          const repo = reposByName.get(ecology.fullName)
          if (!repo) return Promise.resolve(undefined)
          return fetchStructuralSignals(
            token,
            ecology.fullName,
            repo.default_branch,
            ecosystemRepoNames,
          )
        }),
      )

      for (let j = 0; j < batchIndices.length; j++) {
        const ecology = classified[batchIndices[j]!]!
        const signals = signalResults[j]
        if (!signals) continue

        // Observe consolidation for density computation
        const repo = reposByName.get(ecology.fullName)
        const lastActivityDate = repo?.pushed_at
          ? new Date(repo.pushed_at)
          : undefined
        const consolidation = observeConsolidationInterval(
          ecology.declaration?.consolidation_interval_days,
          lastActivityDate,
        )

        signalsByName.set(ecology.fullName, signals)
        const density = observeStructuralDensity(signals, consolidation)
        if (density) densityByName.set(ecology.fullName, density)
      }
    }

    // Rebuild list in original order, spreading density onto classified repos.
    // Unclassified repos (no .grove.yaml) are persisted for ecosystem analysis
    // but excluded from the portfolio view — stewardship is opt-in.
    const allRepos = classified.map((ecology) => {
      const density = densityByName.get(ecology.fullName)
      return density ? { ...ecology, density } : ecology
    })
    const repositories = allRepos.filter((r) => r.classified)
    const unclassified = allRepos.filter((r) => !r.classified)

    // Phase 2: Persist observations to SQLite
    upsertRepositories(
      repos.map((r) => ({
        fullName: r.full_name,
        htmlUrl: r.html_url,
        defaultBranch: r.default_branch,
        pushedAt: r.pushed_at,
        sizeKb: r.size,
        githubId: r.id,
        createdAt: r.created_at,
      })),
    )

    recordSnapshotBatch(
      allRepos.map((ecology) => ({
        ecology,
        signals: signalsByName.get(ecology.fullName),
        density: densityByName.get(ecology.fullName),
      })),
    )

    for (const ecology of allRepos) {
      recordDeclarationIfChanged(
        ecology.fullName,
        ecology.declaration,
        ecology.classified,
      )
    }

    const climate = getCurrentClimate(identity.id)
    // Windows follow identity across renames; the id travels alongside the
    // ecology for evaluation only.
    const subjects = repositories.map((r) => ({
      ...r,
      githubId: idByName.get(r.fullName),
    }))
    const ecosystemTriggers = evaluatePortfolioEcosystemTriggers(
      climate,
      subjects,
    )

    // §5.4 — Evaluate proposal escalation (requires declared climate)
    const climateProposal = climate
      ? evaluatePortfolioProposals(climate, subjects, identity.id)
      : undefined

    return {
      kind: 'observed',
      portfolio: {
        repositories,
        unclassified,
        climate,
        ecosystemTriggers,
        climateProposal,
      },
    }
  },
)
