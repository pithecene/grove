import type { RepositoryResolution } from '@grove/github'

import type { BindingFloorBasis, GroveDb } from './db'
import {
  findOverlappingBinding,
  getObservedSpanForName,
  lastObservedUnderOtherName,
  listUnboundNames,
  recordResolution,
  recordResolvedBinding,
} from './db'
import { isWithinScope, type PortfolioScope } from './scope'

/** Resolves a historical name against GitHub (injectable for tests). */
export type NameResolver = (fullName: string) => Promise<RepositoryResolution>

export type BackfillOutcome =
  | 'bound'
  | 'already_bound'
  | 'name_reused'
  | 'not_found'
  | 'forbidden'
  | 'error'
  | 'out_of_scope'
  /** The span is already held by another identity under this name; nothing recorded */
  | 'overlap'

export interface BackfillEntry {
  fullName: string
  outcome: BackfillOutcome
  githubId?: number
  resolvedFullName?: string
  httpStatus?: number
  /** Observation span under this name that the binding covers */
  boundSpan?: { first: string; last: string }
  /** Observation span under this name left unbound (cannot be the resolved repository's) */
  unboundSpan?: { first: string; last: string }
  /** What bounded the earliest bound row when part of the span stays unbound */
  floorBasis?: Exclude<BindingFloorBasis, 'earliest_row'>
  /** The identity's other name whose last observation set the floor */
  previousName?: string
  message?: string
}

export interface BackfillReport {
  attemptedAt: string
  apply: boolean
  entries: BackfillEntry[]
  bindingsInserted: number
}

export interface BackfillOptions {
  /** false = dry run: resolve and report, write nothing */
  apply: boolean
  /** Names to process; defaults to every name without a binding */
  names?: string[]
  /**
   * Configured portfolio scope. Every unbound name is still resolved (a
   * former name may belong to another owner), but nothing is recorded unless
   * the repository it resolves to is within scope; an unresolved name is
   * recorded only when the name itself is within scope.
   */
  scope?: PortfolioScope
  /** Clock, injectable for tests */
  now?: () => string
}

type ResolvedRepo = Extract<RepositoryResolution, { outcome: 'resolved' }>['repo']

interface Candidate {
  fullName: string
  repo: ResolvedRepo
  status: number
  span: { first: string; last: string } | undefined
}

/**
 * Attach evidence-backed identity bindings to historical repository names.
 *
 * For each name with no binding, asks GitHub what the name denotes today.
 * GitHub follows renames with a redirect, so an old name resolves to the
 * current repository and its immutable id — that answer is recorded as the
 * binding's evidence. Original observations are never modified.
 *
 * - What GitHub answers proves which repository holds the name *now*, not
 *   since when. Rows under the name are bound only back to the latest
 *   instant that excludes them: the repository's creation time (older rows
 *   cannot be its own), or — stronger — the repository's last observation
 *   under another name, since it holds one name at a time. The earlier span
 *   stays unbound and the resolution says so (`name_reused`).
 * - Names are bound in the order their observations end, so a name the
 *   repository held earlier floors a name it took later.
 * - A 404 is recorded as not found *or not accessible*; nothing is deleted
 *   or inferred.
 * - Re-running is idempotent: bound names are skipped, existing bindings are
 *   never overwritten, unresolved names are simply re-attempted.
 * - With a scope, only repositories within it are recorded (see
 *   `BackfillOptions.scope`); everything else is reported as `out_of_scope`.
 */
export async function backfillIdentities(
  db: GroveDb,
  resolve: NameResolver,
  options: BackfillOptions,
): Promise<BackfillReport> {
  const now = options.now ?? (() => new Date().toISOString())
  const attemptedAt = now()
  const names = options.names ?? listUnboundNames(db)
  const entries: BackfillEntry[] = []
  let bindingsInserted = 0

  // Phase 1 — resolve every name; record what cannot be bound.
  const candidates: Candidate[] = []
  for (const fullName of names) {
    const resolution = await resolve(fullName)
    const span = getObservedSpanForName(fullName, db)

    if (resolution.outcome !== 'resolved') {
      if (!isWithinScope(fullName, options.scope)) {
        entries.push({ fullName, outcome: 'out_of_scope', httpStatus: resolution.status })
        continue
      }
      const entry: BackfillEntry = {
        fullName,
        outcome: resolution.outcome,
        httpStatus: resolution.status,
        message: resolution.outcome === 'error' ? resolution.message : undefined,
      }
      entries.push(entry)
      if (options.apply) {
        recordResolution(
          {
            fullName,
            attemptedAt,
            outcome: resolution.outcome,
            httpStatus: resolution.status,
            evidence: { message: entry.message },
          },
          db,
        )
      }
      continue
    }

    const { repo } = resolution
    if (!isWithinScope(repo.full_name, options.scope)) {
      entries.push({
        fullName,
        outcome: 'out_of_scope',
        githubId: repo.id,
        resolvedFullName: repo.full_name,
        httpStatus: resolution.status,
      })
      continue
    }

    candidates.push({ fullName, repo, status: resolution.status, span })
  }

  // Phase 2 — bind in the order observations end, earliest-ending first.
  candidates.sort((a, b) =>
    (a.span?.last ?? attemptedAt).localeCompare(b.span?.last ?? attemptedAt),
  )

  for (const { fullName, repo, status, span } of candidates) {
    // Without any snapshot the name has no observed span; bind the moment
    // the name itself was recorded so the mapping still exists.
    const observed = span ?? { first: attemptedAt, last: attemptedAt }
    const createdAt = repo.created_at ?? undefined
    const elsewhere = lastObservedUnderOtherName(repo.id, fullName, observed.last, db)

    const floors: Array<{ at: string; basis: Exclude<BindingFloorBasis, 'earliest_row'> }> =
      []
    if (createdAt) floors.push({ at: createdAt, basis: 'created_at' })
    if (elsewhere) {
      floors.push({ at: elsewhere.lastObservedAt, basis: 'previous_name_observation' })
    }
    const floor = floors
      .filter((f) => f.at > observed.first)
      .reduce<(typeof floors)[number] | undefined>(
        (top, f) => (!top || f.at > top.at ? f : top),
        undefined,
      )

    let boundSpan: { first: string; last: string } | undefined = observed
    let unboundSpan: { first: string; last: string } | undefined
    let outcome: BackfillOutcome = 'bound'

    if (floor) {
      // The name was observed before this repository could have held it.
      outcome = 'name_reused'
      if (observed.last >= floor.at) {
        boundSpan = { first: floor.at, last: observed.last }
        unboundSpan = { first: observed.first, last: floor.at }
      } else {
        boundSpan = undefined
        unboundSpan = observed
      }
    }

    const entry: BackfillEntry = {
      fullName,
      outcome,
      githubId: repo.id,
      resolvedFullName: repo.full_name,
      httpStatus: status,
      boundSpan,
      unboundSpan,
      floorBasis: floor?.basis,
      previousName:
        floor?.basis === 'previous_name_observation' ? elsewhere?.fullName : undefined,
    }

    // Another identity already holds this name over (part of) the span —
    // e.g. a live observation recorded a reuse while this name was queued.
    // Nothing is written; the conflict is reported, never resolved by guess.
    const overlap = boundSpan
      ? findOverlappingBinding(fullName, repo.id, boundSpan.first, boundSpan.last, db)
      : undefined
    if (overlap) {
      entries.push({
        ...entry,
        outcome: 'overlap',
        message: `name bound to identity ${overlap.githubId} from ${overlap.firstObservedAt} to ${overlap.lastObservedAt}`,
      })
      continue
    }

    if (options.apply) {
      if (boundSpan) {
        const inserted = recordResolvedBinding(
          {
            githubId: repo.id,
            fullName,
            firstObservedAt: boundSpan.first,
            lastObservedAt: boundSpan.last,
            resolvedAt: attemptedAt,
            evidence: {
              resolved_full_name: repo.full_name,
              http_status: status,
              created_at: createdAt ?? null,
              name_reused: outcome === 'name_reused',
              floor_basis: floor?.basis ?? null,
              previous_name: entry.previousName ?? null,
            },
          },
          db,
        )
        if (inserted) bindingsInserted++
        else entry.outcome = 'already_bound'
      }
      recordResolution(
        {
          fullName,
          attemptedAt,
          outcome,
          httpStatus: status,
          githubId: repo.id,
          resolvedFullName: repo.full_name,
          evidence: {
            created_at: createdAt ?? null,
            bound_span: boundSpan ?? null,
            unbound_span: unboundSpan ?? null,
            floor_basis: floor?.basis ?? null,
            previous_name: entry.previousName ?? null,
          },
        },
        db,
      )
    }

    entries.push(entry)
  }

  return { attemptedAt, apply: options.apply, entries, bindingsInserted }
}
