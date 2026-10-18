import type { RepositoryResolution } from '@grove/github'

import type { GroveDb } from './db'
import {
  findOverlappingBinding,
  getObservedSpanForName,
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
  /** Observation span under this name left unbound (predates the resolved repository) */
  unboundSpan?: { first: string; last: string }
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

/**
 * Attach evidence-backed identity bindings to historical repository names.
 *
 * For each name with no binding, asks GitHub what the name denotes today.
 * GitHub follows renames with a redirect, so an old name resolves to the
 * current repository and its immutable id — that answer is recorded as the
 * binding's evidence. Original observations are never modified.
 *
 * - A name whose observations predate the resolved repository's creation
 *   cannot all belong to it (the name was reused): only observations from
 *   the creation time onward are bound; the earlier span stays unbound and
 *   the resolution says so.
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

    // Without any snapshot the name has no observed span; bind the moment
    // the name itself was recorded so the mapping still exists.
    const observed = span ?? { first: attemptedAt, last: attemptedAt }
    const createdAt = repo.created_at ?? undefined

    let boundSpan: { first: string; last: string } | undefined = observed
    let unboundSpan: { first: string; last: string } | undefined
    let outcome: BackfillOutcome = 'bound'

    if (createdAt && observed.first < createdAt) {
      // The name was observed before this repository existed: reuse.
      outcome = 'name_reused'
      if (observed.last >= createdAt) {
        boundSpan = { first: createdAt, last: observed.last }
        unboundSpan = { first: observed.first, last: createdAt }
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
      httpStatus: resolution.status,
      boundSpan,
      unboundSpan,
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
              http_status: resolution.status,
              created_at: createdAt ?? null,
              name_reused: outcome === 'name_reused',
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
          httpStatus: resolution.status,
          githubId: repo.id,
          resolvedFullName: repo.full_name,
          evidence: {
            created_at: createdAt ?? null,
            bound_span: boundSpan ?? null,
            unbound_span: unboundSpan ?? null,
          },
        },
        db,
      )
    }

    entries.push(entry)
  }

  return { attemptedAt, apply: options.apply, entries, bindingsInserted }
}
