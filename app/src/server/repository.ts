import {
  findReferenceSnapshot,
  observeAccessibility,
  observeCapability,
  observeConsolidationInterval,
  observeMotionDrift,
  observePhaseDuration,
  observeShapeDrift,
  observeStructuralDensity,
  surfaceRitualInvitations,
} from '@grove/core'
import type {
  AccessibilityObservation,
  CapabilityObservation,
  ConsolidationObservation,
  MotionDriftObservation,
  PhaseDurationObservation,
  RepositoryEcology,
  RitualInvitation,
  ShapeDriftObservation,
} from '@grove/core'
import {
  classifyRepository,
  fetchRepository,
  fetchStructuralSignals,
} from '@grove/github'
import { createServerFn } from '@tanstack/react-start'

import {
  getBindingsForIdentity,
  getDeclarationHistoryForIdentity,
  getSnapshotHistoryForIdentity,
  recordDeclarationIfChanged,
  recordSnapshot,
  upsertRepository,
} from './db'
import { type AccessFailure, accessFailure } from './github-state'
import { getStewardIdentity } from './identity'
import { isWithinScope, parseScope } from './scope'
import type { TimelineEntry } from './timeline'
import { buildTimeline } from './timeline'

export interface RepositoryDetail {
  ecology: RepositoryEcology
  consolidation?: ConsolidationObservation
  phaseDuration?: PhaseDurationObservation
  shapeDrift?: ShapeDriftObservation
  motionDrift?: MotionDriftObservation
  accessibility?: AccessibilityObservation
  capability?: CapabilityObservation
  ritualInvitations: RitualInvitation[]
  timeline: TimelineEntry[]
}

/**
 * What a repository lookup produced. Only `observed` carries detail; the
 * other kinds say why nothing was observed, without guessing.
 */
export type RepositoryLookup =
  | { kind: 'observed'; detail: RepositoryDetail }
  | AccessFailure
  /** The repository is outside the selected portfolio scope; nothing fetched or recorded */
  | { kind: 'out_of_scope' }

export const loadRepository = createServerFn({ method: 'GET' })
  .validator((data: { owner: string; name: string }) => data)
  .handler(async ({ data }): Promise<RepositoryLookup> => {
    const identity = await getStewardIdentity()

    if (!identity) {
      throw new Error('Not authenticated')
    }

    const token = identity.token

    const scope = parseScope()
    const fullName = `${data.owner}/${data.name}`
    // Outside the selected scope nothing is fetched or recorded.
    if (!isWithinScope(fullName, scope)) return { kind: 'out_of_scope' }

    const repoAnswer = await fetchRepository(token, fullName)
    if (repoAnswer.kind !== 'ok') return accessFailure(repoAnswer, 'this repository')
    const repo = repoAnswer.value
    // GitHub follows renames/transfers with a redirect: the resolved
    // repository may live outside the scope even when the requested name
    // did not. Nothing about it is classified or recorded in that case.
    if (!isWithinScope(repo.full_name, scope)) return { kind: 'out_of_scope' }

    // Classify and fetch structural signals in parallel.
    // Entanglement (ecosystemRepoNames) is omitted here: it is a
    // portfolio-level signal that requires fetching all user repos,
    // which would add N-page pagination cost per detail page load.
    // The entanglement factor is weighted at 0.15 — omitting it may
    // produce a slightly lower tier than the portfolio view in rare
    // cases, but avoids disproportionate API cost for a single-repo view.
    // Reading `.grove.yaml` is a further GitHub request with its own answer;
    // structural signals already treat partial results as valid.
    const [ecologyAnswer, signals] = await Promise.all([
      classifyRepository(token, repo),
      fetchStructuralSignals(token, fullName, repo.default_branch),
    ])
    if (ecologyAnswer.kind !== 'ok') {
      return accessFailure(ecologyAnswer, `the declaration of ${repo.full_name}`)
    }
    const ecology = ecologyAnswer.value

    // Observe consolidation interval
    const lastActivityDate = repo.pushed_at
      ? new Date(repo.pushed_at)
      : undefined
    const consolidation = observeConsolidationInterval(
      ecology.declaration?.consolidation_interval_days,
      lastActivityDate,
    )

    // Derive density from structural signals
    const density = observeStructuralDensity(signals, consolidation)

    // Phase 2: Persist observations to SQLite
    upsertRepository({
      fullName: repo.full_name,
      htmlUrl: repo.html_url,
      defaultBranch: repo.default_branch,
      pushedAt: repo.pushed_at,
      sizeKb: repo.size,
      githubId: repo.id,
      createdAt: repo.created_at,
    })

    const enrichedEcology = { ...ecology, density }
    const snapshotWasRecorded = recordSnapshot(enrichedEcology, signals, density)
    recordDeclarationIfChanged(
      ecology.fullName,
      ecology.declaration,
      ecology.classified,
    )

    // Build structural timeline from persisted history, followed across every
    // name this identity was observed under (the live binding was recorded by
    // the upsert above, so the current name is always included).
    // Fetch one extra row to distinguish "exactly at limit" from "truncated".
    const HISTORY_LIMIT = 50
    const snapshotRows = getSnapshotHistoryForIdentity(repo.id, { limit: HISTORY_LIMIT + 1 })
    const declarationRows = getDeclarationHistoryForIdentity(repo.id, HISTORY_LIMIT + 1)
    const historyComplete = snapshotRows.length <= HISTORY_LIMIT
    const declarationHistoryComplete = declarationRows.length <= HISTORY_LIMIT
    const snapshots = snapshotRows.slice(0, HISTORY_LIMIT)
    const declarations = declarationRows.slice(0, HISTORY_LIMIT)
    const timeline = buildTimeline(
      snapshots,
      declarations,
      snapshotWasRecorded,
      historyComplete,
      { bindings: getBindingsForIdentity(repo.id) },
      declarationHistoryComplete,
    )

    // Observe phase duration from declaration history (uses already-fetched rows).
    // If all fetched rows share the current phase, the true start may predate
    // the fetch window — suppress the observation to avoid understating duration.
    const phaseLastDeclaredAt = findPhaseDeclarationTimestamp(
      ecology.declaration?.phase,
      declarationRows,
      declarationHistoryComplete,
    )
    const phaseDuration = observePhaseDuration(
      ecology.declaration?.phase,
      phaseLastDeclaredAt,
      ecology.declaration?.horizon,
    )

    // Observe shape and motion drift (uses already-fetched data).
    // Pass full snapshotRows (pre-slice) so the +1 boundary row is
    // available as a potential reference. Pass historyComplete to
    // suppress when the phase baseline cannot be reliably established.
    const referenceSnapshot = findReferenceSnapshot(
      phaseLastDeclaredAt,
      snapshotRows,
      historyComplete,
    )
    const shapeDrift = referenceSnapshot
      ? observeShapeDrift(referenceSnapshot, signals, density?.tier)
      : undefined
    const motionDrift = ecology.declaration?.phase
      ? observeMotionDrift(
          ecology.declaration.phase,
          signals.commitsLast30d,
          signals.commitsLast90d,
        )
      : undefined

    // Observe accessibility and capability
    const accessibility = observeAccessibility(signals, ecology.declaration)
    const capability = observeCapability(signals, ecology.declaration)

    // Surface ritual invitations
    const ritualInvitations = surfaceRitualInvitations(
      ecology.declaration,
      consolidation,
      phaseDuration,
    )

    return {
      kind: 'observed',
      detail: {
        ecology: enrichedEcology,
        consolidation,
        phaseDuration,
        shapeDrift,
        motionDrift,
        accessibility,
        capability,
        ritualInvitations,
        timeline,
      },
    }
  })

/**
 * Walk DESC-ordered declaration rows to find the oldest row in the
 * current consecutive run of the same phase value.
 * Returns the observedAt timestamp of that row, or undefined.
 *
 * When historyComplete is false (i.e. the fetch window was truncated)
 * and every row matches the current phase, the true phase start may
 * predate the window. Returns undefined in that case to avoid
 * understating duration.
 */
export function findPhaseDeclarationTimestamp(
  currentPhase: string | undefined,
  declarationsDesc: { phase: string | null; observedAt: string }[],
  historyComplete: boolean,
): string | undefined {
  if (!currentPhase || declarationsDesc.length === 0) {
    return undefined
  }

  let oldest: string | undefined
  let allMatched = true
  for (const row of declarationsDesc) {
    if (row.phase === currentPhase) {
      oldest = row.observedAt
    } else {
      // Phase changed — the consecutive run from the top has ended
      allMatched = false
      break
    }
  }

  // If every row matched and history was truncated, the real start
  // is older than our window — suppress the observation.
  if (allMatched && !historyComplete) {
    return undefined
  }

  return oldest
}
