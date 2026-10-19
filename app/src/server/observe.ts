import type {
  ClimateProposal,
  DensityObservation,
  EcosystemTriggerResult,
  Portfolio,
  RepositoryEcology,
  StructuralSignals,
} from '@grove/core'
import { observeConsolidationInterval, observeStructuralDensity } from '@grove/core'
import { classifyRepository, fetchStructuralSignals, fetchUserRepos } from '@grove/github'

import type { GroveDb, RunMethod } from './db'
import {
  finishRun,
  getCurrentClimate,
  getDb,
  recordDeclarationIfChanged,
  recordRunRepository,
  recordSnapshotBatch,
  startRun,
  upsertRepositories,
} from './db'
import {
  evaluatePortfolioEcosystemTriggers,
  evaluatePortfolioProposals,
} from './ecosystem-triggers'
import { type AccessFailure, accessFailure } from './github-state'
import type { IdentityUnavailableReason, StewardIdentity } from './identity'
import { applyScope, parseScope } from './scope'

const BATCH_SIZE = 10

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

export interface ObserveOptions {
  /** How this collection came about; recorded on the run */
  method: RunMethod
  db?: GroveDb
}

/**
 * Observe the configured portfolio once: list, classify, measure, persist,
 * evaluate — as one recorded run. A page visit and the `collect` command
 * share this pipeline; neither has a second one.
 *
 * The run records what was attempted (`full_portfolio`: the whole scope)
 * and, per repository, what came of it: `observed`, `unchanged` (within the
 * snapshot throttle), or `unavailable` with the GitHub answer kind. A
 * listing or a declaration GitHub did not answer ends the run incomplete
 * with that answer recorded; nothing is written as an observation for it.
 */
export async function observePortfolio(
  identity: StewardIdentity,
  options: ObserveOptions,
): Promise<{ lookup: PortfolioLookup; runId: number }> {
  const db = options.db ?? getDb()
  const token = identity.token
  // Explicit, private selection of what to observe (GROVE_SCOPE_*).
  // Repositories outside the scope are not enumerated further and nothing
  // previously recorded about them is touched.
  const scope = parseScope()
  const runId = startRun(
    { method: options.method, stewardId: identity.id, fullPortfolio: true, scope },
    db,
  )

  const listing = await fetchUserRepos(token)
  if (listing.kind !== 'ok') {
    finishRun(runId, { complete: false, answer: listing.kind }, db)
    return { lookup: accessFailure(listing, 'the portfolio listing'), runId }
  }
  const repos = applyScope(listing.value, scope)
  const idByName = new Map(repos.map((r) => [r.full_name, r.id]))

  // Phase 1: Classify in batches
  const classified: RepositoryEcology[] = []
  for (let i = 0; i < repos.length; i += BATCH_SIZE) {
    const batch = repos.slice(i, i + BATCH_SIZE)
    const answers = await Promise.all(batch.map((repo) => classifyRepository(token, repo)))
    // One repository GitHub did not answer about is not "unclassified":
    // nothing is recorded as an observation for the portfolio this time.
    const failedAt = answers.findIndex((a) => a.kind !== 'ok')
    const failed = answers[failedAt]
    if (failed && failed.kind !== 'ok') {
      const repo = batch[failedAt]
      // Every answer in the batch is kept on the run: what GitHub did
      // answer about (`not_recorded`, since no observation is written this
      // time) and every repository it did not, each with its own kind.
      for (const name of classified.map((e) => e.fullName)) {
        recordRunRepository(
          runId,
          { githubId: idByName.get(name), fullName: name, outcome: 'not_recorded' },
          db,
        )
      }
      batch.forEach((r, k) => {
        const answer = answers[k]
        if (!answer) return
        recordRunRepository(
          runId,
          answer.kind === 'ok'
            ? { githubId: r.id, fullName: r.full_name, outcome: 'not_recorded' }
            : { githubId: r.id, fullName: r.full_name, outcome: 'unavailable', answer: answer.kind },
          db,
        )
      })
      finishRun(runId, { complete: false, answer: failed.kind }, db)
      return {
        lookup: accessFailure(failed, `the declaration of ${repo.full_name}`),
        runId,
      }
    }
    classified.push(...answers.flatMap((a) => (a.kind === 'ok' ? [a.value] : [])))
  }

  // Phase 2: Enrich classified repos with structural signals
  const ecosystemRepoNames = repos.map((r) => r.full_name)
  const reposByName = new Map(repos.map((r) => [r.full_name, r]))

  // Collect only classified repos for signal fetching, preserving indices
  const classifiedIndices: number[] = []
  for (let i = 0; i < classified.length; i++) {
    if (classified[i]?.classified) classifiedIndices.push(i)
  }

  // Fetch signals in batches for classified repos only
  const signalsByName = new Map<string, StructuralSignals>()
  const densityByName = new Map<string, DensityObservation>()

  for (let i = 0; i < classifiedIndices.length; i += BATCH_SIZE) {
    const batchIndices = classifiedIndices.slice(i, i + BATCH_SIZE)
    const signalResults = await Promise.all(
      batchIndices.map((idx) => {
        const ecology = classified[idx]
        const repo = ecology ? reposByName.get(ecology.fullName) : undefined
        if (!ecology || !repo) return Promise.resolve(undefined)
        return fetchStructuralSignals(
          token,
          ecology.fullName,
          repo.default_branch,
          ecosystemRepoNames,
        )
      }),
    )

    for (let j = 0; j < batchIndices.length; j++) {
      const idx = batchIndices[j]
      const ecology = idx === undefined ? undefined : classified[idx]
      const signals = signalResults[j]
      if (!ecology || !signals) continue

      // Observe consolidation for density computation
      const repo = reposByName.get(ecology.fullName)
      const lastActivityDate = repo?.pushed_at ? new Date(repo.pushed_at) : undefined
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

  // Phase 3: Persist observations
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
    db,
  )

  // Rows record the identity they were observed for (never dependent on a binding).
  const recorded = recordSnapshotBatch(
    allRepos.map((ecology) => ({
      ecology: { ...ecology, githubId: idByName.get(ecology.fullName) },
      signals: signalsByName.get(ecology.fullName),
      density: densityByName.get(ecology.fullName),
    })),
    db,
  )

  for (const ecology of allRepos) {
    recordDeclarationIfChanged(
      ecology.fullName,
      ecology.declaration,
      ecology.classified,
      db,
      idByName.get(ecology.fullName),
    )
  }

  // Membership: every repository in scope got an outcome this run.
  for (const repo of repos) {
    recordRunRepository(
      runId,
      {
        githubId: repo.id,
        fullName: repo.full_name,
        outcome: recorded.has(repo.full_name) ? 'observed' : 'unchanged',
      },
      db,
    )
  }
  finishRun(runId, { complete: true }, db)

  const climate = getCurrentClimate(identity.id, db)
  // Windows follow identity across renames; the id travels alongside the
  // ecology for evaluation only.
  const subjects = repositories.map((r) => ({
    ...r,
    githubId: idByName.get(r.fullName),
  }))
  const ecosystemTriggers = evaluatePortfolioEcosystemTriggers(climate, subjects, db)

  // §5.4 — Evaluate proposal escalation (requires declared climate)
  const climateProposal = climate
    ? evaluatePortfolioProposals(climate, subjects, identity.id, db)
    : undefined

  return {
    lookup: {
      kind: 'observed',
      portfolio: { repositories, unclassified, climate, ecosystemTriggers, climateProposal },
    },
    runId,
  }
}
