import { and, asc, desc, eq, gte, isNull, lte, ne, or, sql } from 'drizzle-orm'

import type { GroveDb } from './client'
import { getDb } from './client'
import {
  declarationChanges,
  ecologySnapshots,
  identityResolutions,
  repositories,
  repositoryBindings,
} from './schema'

export type BindingRow = typeof repositoryBindings.$inferSelect
export type ResolutionRow = typeof identityResolutions.$inferSelect

export type BindingMethod = 'observed' | 'github_redirect'

/** What bounds the earliest row attributed to an identity under a name. */
export type BindingFloorBasis =
  /** the earliest row stored under the name */
  | 'earliest_row'
  /** the repository's creation time: older rows cannot be its own */
  | 'created_at'
  /** the identity's last observation under another name: it holds one name at a time */
  | 'previous_name_observation'

/** Where an identity was last observed under some other name. */
export interface OtherNameObservation {
  fullName: string
  lastObservedAt: string
}

/**
 * The identity's latest observation under a name other than `fullName`
 * before `before`, if any — from its binding segments and from rows that
 * recorded the identity directly (which need no binding to count). Rows
 * stored under `fullName` up to that instant cannot be this identity's.
 */
export function lastObservedUnderOtherName(
  githubId: number,
  fullName: string,
  before: string,
  db: GroveDb = getDb(),
): OtherNameObservation | undefined {
  const candidates: OtherNameObservation[] = getBindingsForIdentity(githubId, db).map((b) => ({
    fullName: b.fullName,
    lastObservedAt: b.lastObservedAt,
  }))
  for (const table of [ecologySnapshots, declarationChanges] as const) {
    const tagged = db
      .select({
        fullName: table.fullName,
        lastObservedAt: sql<string | null>`max(${table.observedAt})`,
      })
      .from(table)
      .where(and(eq(table.githubId, githubId), ne(table.fullName, fullName)))
      .groupBy(table.fullName)
      .all()
    for (const row of tagged) {
      if (row.lastObservedAt) candidates.push({ fullName: row.fullName, lastObservedAt: row.lastObservedAt })
    }
  }
  return candidates
    .filter((c) => c.fullName !== fullName && c.lastObservedAt < before)
    .reduce<OtherNameObservation | undefined>(
      (latest, c) => (!latest || c.lastObservedAt > latest.lastObservedAt ? c : latest),
      undefined,
    )
}

/**
 * Record that `fullName` was observed to denote `githubId` at `observedAt`.
 *
 * - When the name's most recent binding already denotes this identity, the
 *   observation extends that segment's `last_observed_at`.
 * - Otherwise a new time segment starts at `observedAt`: a name observed
 *   under a *different* id (reuse), or an identity returning to a name it
 *   held before — whether or not another identity held it in between —
 *   never extends a segment across the interval it spent under another name.
 * - A name with no binding at all (a database recorded before identity
 *   tracking) adopts the rows already stored under it back to the latest
 *   instant that excludes them: the repository's `created_at` when known
 *   (rows older than the repository cannot be its own), or — stronger — the
 *   identity's last observation under another name (a repository holds one
 *   name at a time). The adoption and its basis are recorded as evidence.
 * - Bounds are exact timestamps. Rows stored under the name after the
 *   segment started extend `last_observed_at`, so a snapshot or declaration
 *   recorded moments after the binding in the same request is covered.
 */
export function recordObservedBinding(
  githubId: number,
  fullName: string,
  observedAt: string,
  db: GroveDb = getDb(),
  createdAt?: string | null,
): void {
  const existing = getBindingsForName(fullName, db)
  const current = existing[0]
  // The identity's latest observation under another name. When it is later
  // than this name's current segment, the identity left the name and is
  // now returning to it.
  const elsewhere = lastObservedUnderOtherName(githubId, fullName, observedAt, db)
  const returning =
    current !== undefined &&
    elsewhere !== undefined &&
    elsewhere.lastObservedAt > current.lastObservedAt

  if (current && current.githubId === githubId && !returning) {
    // Same identity, same segment: widen it to include this observation.
    if (observedAt > current.lastObservedAt) {
      db.update(repositoryBindings)
        .set({ lastObservedAt: observedAt })
        .where(eq(repositoryBindings.id, current.id))
        .run()
    } else if (observedAt < current.firstObservedAt) {
      db.update(repositoryBindings)
        .set({ firstObservedAt: observedAt })
        .where(eq(repositoryBindings.id, current.id))
        .run()
    }
    extendBindingForName(fullName, observedAt, db)
    return
  }

  let firstObservedAt = observedAt
  let evidence: string | null = null

  if (existing.length === 0) {
    const span = getObservedSpanForName(fullName, db)
    if (span && span.first < observedAt) {
      const floors: Array<{ at: string; basis: BindingFloorBasis }> = [
        { at: span.first, basis: 'earliest_row' },
      ]
      if (createdAt) floors.push({ at: createdAt, basis: 'created_at' })
      if (elsewhere) {
        floors.push({ at: elsewhere.lastObservedAt, basis: 'previous_name_observation' })
      }
      const floor = floors.reduce((top, f) => (f.at > top.at ? f : top))
      if (floor.at < observedAt) {
        firstObservedAt = floor.at
        evidence = JSON.stringify({
          adopted_prior_rows: true,
          earliest_row: span.first,
          created_at: createdAt ?? null,
          floor_basis: floor.basis,
          previous_name: elsewhere?.fullName ?? null,
          previous_name_last_observed_at: elsewhere?.lastObservedAt ?? null,
        })
      }
    }
  }

  db.insert(repositoryBindings)
    .values({
      githubId,
      fullName,
      firstObservedAt,
      lastObservedAt: observedAt,
      method: 'observed',
      resolvedAt: observedAt,
      evidence,
    })
    .run()

  extendBindingForName(fullName, observedAt, db)
}

/**
 * Extend the most recent binding of a name so that every row stored under
 * the name between the binding's start and `observedAt` is inside its
 * bounds. Called after a snapshot or declaration row is recorded, and on
 * every observation (which also repairs bounds left short by an earlier
 * version). Rows later than `observedAt` are never pulled in: they belong
 * to whatever the name denotes at their own time.
 */
export function extendBindingForName(
  fullName: string,
  observedAt: string,
  db: GroveDb = getDb(),
): void {
  const current = getBindingsForName(fullName, db)[0]
  if (!current) return

  const latest = db
    .select({
      snapshot: sql<
        string | null
      >`(select max(${ecologySnapshots.observedAt}) from ${ecologySnapshots} where ${ecologySnapshots.fullName} = ${fullName} and ${ecologySnapshots.observedAt} >= ${current.firstObservedAt} and ${ecologySnapshots.observedAt} <= ${observedAt})`,
      declaration: sql<
        string | null
      >`(select max(${declarationChanges.observedAt}) from ${declarationChanges} where ${declarationChanges.fullName} = ${fullName} and ${declarationChanges.observedAt} >= ${current.firstObservedAt} and ${declarationChanges.observedAt} <= ${observedAt})`,
    })
    .from(repositoryBindings)
    .where(eq(repositoryBindings.id, current.id))
    .get()

  const candidates = [observedAt, latest?.snapshot, latest?.declaration].filter(
    (v): v is string => typeof v === 'string',
  )
  const last = candidates.reduce((a, b) => (a > b ? a : b), current.lastObservedAt)
  if (last > current.lastObservedAt) {
    db.update(repositoryBindings)
      .set({ lastObservedAt: last })
      .where(eq(repositoryBindings.id, current.id))
      .run()
  }
}

/**
 * A binding of `fullName` to a *different* identity whose interval overlaps
 * [first, last], if any. Two identities can never hold the same name at the
 * same instant, so such an overlap means the proposed segment is wrong.
 */
export function findOverlappingBinding(
  fullName: string,
  githubId: number,
  firstObservedAt: string,
  lastObservedAt: string,
  db: GroveDb = getDb(),
): BindingRow | undefined {
  return getBindingsForName(fullName, db).find(
    (b) =>
      b.githubId !== githubId &&
      b.firstObservedAt <= lastObservedAt &&
      b.lastObservedAt >= firstObservedAt,
  )
}

/**
 * Record a binding reconstructed from evidence (e.g. a GitHub redirect).
 * Never adds to a (id, name) pair that already has a binding, so repeated
 * backfills are idempotent and live observations keep precedence; never
 * inserts a segment overlapping another identity's segment for the name.
 * Returns whether a row was inserted.
 */
export function recordResolvedBinding(
  binding: {
    githubId: number
    fullName: string
    firstObservedAt: string
    lastObservedAt: string
    resolvedAt: string
    evidence: Record<string, unknown>
  },
  db: GroveDb = getDb(),
): boolean {
  const already = getBindingsForIdentity(binding.githubId, db).some(
    (b) => b.fullName === binding.fullName,
  )
  if (already) return false
  if (
    findOverlappingBinding(
      binding.fullName,
      binding.githubId,
      binding.firstObservedAt,
      binding.lastObservedAt,
      db,
    )
  ) {
    return false
  }

  db.insert(repositoryBindings)
    .values({
      githubId: binding.githubId,
      fullName: binding.fullName,
      firstObservedAt: binding.firstObservedAt,
      lastObservedAt: binding.lastObservedAt,
      method: 'github_redirect',
      resolvedAt: binding.resolvedAt,
      evidence: JSON.stringify(binding.evidence),
    })
    .run()
  return true
}

/** All binding segments of an identity, earliest first. */
export function getBindingsForIdentity(
  githubId: number,
  db: GroveDb = getDb(),
): BindingRow[] {
  return db
    .select()
    .from(repositoryBindings)
    .where(eq(repositoryBindings.githubId, githubId))
    .orderBy(asc(repositoryBindings.firstObservedAt), asc(repositoryBindings.id))
    .all()
}

/** All binding segments of a name, most recently observed first. */
export function getBindingsForName(
  fullName: string,
  db: GroveDb = getDb(),
): BindingRow[] {
  return db
    .select()
    .from(repositoryBindings)
    .where(eq(repositoryBindings.fullName, fullName))
    .orderBy(desc(repositoryBindings.lastObservedAt), desc(repositoryBindings.id))
    .all()
}

/**
 * The instant the name's current binding segment began, if any binding
 * exists. Rows recorded under the name before it belong to another identity
 * (or to this one under an earlier segment) and must not stand in for this
 * segment's most recent observation.
 */
export function currentSegmentStart(
  fullName: string,
  db: GroveDb = getDb(),
): string | undefined {
  return getBindingsForName(fullName, db)[0]?.firstObservedAt
}

/** The identity a name denoted most recently, if any binding exists. */
export function getIdentityForName(
  fullName: string,
  db: GroveDb = getDb(),
): number | undefined {
  return getBindingsForName(fullName, db)[0]?.githubId
}

/** Repository names with no binding at all (candidates for backfill). */
export function listUnboundNames(db: GroveDb = getDb()): string[] {
  return db
    .select({ fullName: repositories.fullName })
    .from(repositories)
    .leftJoin(repositoryBindings, eq(repositoryBindings.fullName, repositories.fullName))
    .where(isNull(repositoryBindings.id))
    .orderBy(asc(repositories.fullName))
    .all()
    .map((row) => row.fullName)
}

/**
 * Earliest and latest row timestamps recorded under a name — snapshots and
 * declaration changes alike — if any.
 */
export function getObservedSpanForName(
  fullName: string,
  db: GroveDb = getDb(),
): { first: string; last: string } | undefined {
  const snapshots = db
    .select({
      first: sql<string | null>`min(${ecologySnapshots.observedAt})`,
      last: sql<string | null>`max(${ecologySnapshots.observedAt})`,
    })
    .from(ecologySnapshots)
    .where(eq(ecologySnapshots.fullName, fullName))
    .get()
  const declarations = db
    .select({
      first: sql<string | null>`min(${declarationChanges.observedAt})`,
      last: sql<string | null>`max(${declarationChanges.observedAt})`,
    })
    .from(declarationChanges)
    .where(eq(declarationChanges.fullName, fullName))
    .get()

  const firsts = [snapshots?.first, declarations?.first].filter(
    (v): v is string => typeof v === 'string',
  )
  const lasts = [snapshots?.last, declarations?.last].filter(
    (v): v is string => typeof v === 'string',
  )
  if (firsts.length === 0 || lasts.length === 0) return undefined
  return {
    first: firsts.reduce((a, b) => (a < b ? a : b)),
    last: lasts.reduce((a, b) => (a > b ? a : b)),
  }
}

/** Record (or replace) the latest resolution attempt for a name. */
export function recordResolution(
  resolution: {
    fullName: string
    attemptedAt: string
    outcome: string
    httpStatus?: number
    githubId?: number
    resolvedFullName?: string
    evidence?: Record<string, unknown>
  },
  db: GroveDb = getDb(),
): void {
  const values = {
    fullName: resolution.fullName,
    attemptedAt: resolution.attemptedAt,
    outcome: resolution.outcome,
    httpStatus: resolution.httpStatus ?? null,
    githubId: resolution.githubId ?? null,
    resolvedFullName: resolution.resolvedFullName ?? null,
    evidence: resolution.evidence ? JSON.stringify(resolution.evidence) : null,
  }
  db.insert(identityResolutions)
    .values(values)
    .onConflictDoUpdate({ target: identityResolutions.fullName, set: values })
    .run()
}

export function getResolution(
  fullName: string,
  db: GroveDb = getDb(),
): ResolutionRow | undefined {
  return db
    .select()
    .from(identityResolutions)
    .where(eq(identityResolutions.fullName, fullName))
    .get()
}

export function listResolutions(db: GroveDb = getDb()): ResolutionRow[] {
  return db
    .select()
    .from(identityResolutions)
    .orderBy(asc(identityResolutions.fullName))
    .all()
}

// ── History across bindings ───────────────────────────────────────

/**
 * Predicate selecting rows observed under one of the identity's names
 * while that name denoted the identity: exact, inclusive timestamp bounds
 * per segment. Rows recorded after a segment started extend its
 * `last_observed_at` (see extendBindingForName), so nothing falls outside
 * by a few milliseconds; a reused or returned-to name is attributed by the
 * exact instant each segment began.
 */
function identityPredicate(
  githubId: number,
  bindings: BindingRow[],
  column: {
    fullName: typeof ecologySnapshots.fullName
    observedAt: typeof ecologySnapshots.observedAt
    githubId: typeof ecologySnapshots.githubId
  },
) {
  // Rows that recorded their identity are matched by it directly, with or
  // without bindings; rows recorded before row identity (null) resolve
  // through the bindings only.
  const byId = eq(column.githubId, githubId)
  if (bindings.length === 0) return byId
  const bySegment = bindings.map((b) =>
    and(
      eq(column.fullName, b.fullName),
      gte(column.observedAt, b.firstObservedAt),
      lte(column.observedAt, b.lastObservedAt),
    ),
  )
  return or(byId, and(isNull(column.githubId), or(...bySegment)))
}

/**
 * Snapshot history of an identity across every name it was bound to,
 * most recent first. Returns [] when the identity has no bindings.
 * `since` (ISO) limits rows to those observed at or after that instant.
 */
export function getSnapshotHistoryForIdentity(
  githubId: number,
  options: { limit?: number; since?: string } = {},
  db: GroveDb = getDb(),
) {
  const bindings = getBindingsForIdentity(githubId, db)

  const predicate = identityPredicate(githubId, bindings, {
    fullName: ecologySnapshots.fullName,
    observedAt: ecologySnapshots.observedAt,
    githubId: ecologySnapshots.githubId,
  })
  const where = options.since
    ? and(predicate, gte(ecologySnapshots.observedAt, options.since))
    : predicate

  const query = db
    .select()
    .from(ecologySnapshots)
    .where(where)
    .orderBy(desc(ecologySnapshots.observedAt), desc(ecologySnapshots.id))
  return options.limit !== undefined ? query.limit(options.limit).all() : query.all()
}

/**
 * Declaration-change history of an identity across every name it was
 * bound to, most recent first. Returns [] when the identity has no bindings.
 */
export function getDeclarationHistoryForIdentity(
  githubId: number,
  limit = 100,
  db: GroveDb = getDb(),
) {
  const bindings = getBindingsForIdentity(githubId, db)

  // Declaration rows share the snapshot columns' shape for name/time.
  const predicate = identityPredicate(githubId, bindings, {
    fullName: declarationChanges.fullName as unknown as typeof ecologySnapshots.fullName,
    observedAt:
      declarationChanges.observedAt as unknown as typeof ecologySnapshots.observedAt,
    githubId: declarationChanges.githubId as unknown as typeof ecologySnapshots.githubId,
  })

  return db
    .select()
    .from(declarationChanges)
    .where(predicate)
    .orderBy(desc(declarationChanges.observedAt), desc(declarationChanges.id))
    .limit(limit)
    .all()
}
