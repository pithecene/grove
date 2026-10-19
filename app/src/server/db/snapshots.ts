import type {
  CalendarSlot,
  DensityObservation,
  RepositoryEcology,
  StructuralSignals,
} from '@grove/core'
import { buildCalendarWindow, shiftDay } from '@grove/core'
import { and, desc, eq, gte, isNull, or } from 'drizzle-orm'

import {
  currentSegmentStart,
  extendBindingForName,
  getSnapshotHistoryForIdentity,
  recordObservedBinding,
} from './bindings'
import type { GroveDb } from './client'
import { getDb } from './client'
import { ecologySnapshots, repositories } from './schema'

/** Minimum interval between snapshots for the same repository (1 hour). */
const MIN_SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000

interface RepositoryRow {
  fullName: string
  htmlUrl: string
  defaultBranch: string
  pushedAt?: string | null
  sizeKb?: number | null
  /** Immutable GitHub id when known; also records a time-bound name binding */
  githubId?: number | null
  /** Repository creation time; bounds adoption of rows recorded before identity tracking */
  createdAt?: string | null
}

/**
 * Upsert a single repository into the reference table.
 * When the immutable id is known, the (id, name) binding is recorded too.
 */
export function upsertRepository(repo: RepositoryRow, db: GroveDb = getDb()) {
  const now = new Date().toISOString()
  // better-sqlite3 transactions are synchronous; statements issued on `db`
  // inside the callback run within the transaction (as recordSnapshot does).
  db.transaction(() => {
    upsertRepositoryRow(repo, now, db)
  })
}

/**
 * Upsert multiple repositories in a single transaction.
 */
export function upsertRepositories(repos: RepositoryRow[], db: GroveDb = getDb()) {
  db.transaction(() => {
    const now = new Date().toISOString()
    for (const repo of repos) {
      upsertRepositoryRow(repo, now, db)
    }
  })
}

function upsertRepositoryRow(repo: RepositoryRow, now: string, db: GroveDb) {
  const githubId = repo.githubId ?? null
  db.insert(repositories)
    .values({
      fullName: repo.fullName,
      htmlUrl: repo.htmlUrl,
      defaultBranch: repo.defaultBranch,
      pushedAt: repo.pushedAt ?? null,
      sizeKb: repo.sizeKb ?? null,
      lastObservedAt: now,
      githubId,
      createdAt: repo.createdAt ?? null,
    })
    .onConflictDoUpdate({
      target: repositories.fullName,
      set: {
        htmlUrl: repo.htmlUrl,
        defaultBranch: repo.defaultBranch,
        pushedAt: repo.pushedAt ?? null,
        sizeKb: repo.sizeKb ?? null,
        lastObservedAt: now,
        // Keep a previously observed id (and creation time) when this observation carries none.
        ...(githubId !== null ? { githubId } : {}),
        ...(repo.createdAt ? { createdAt: repo.createdAt } : {}),
      },
    })
    .run()
  if (githubId !== null) {
    recordObservedBinding(githubId, repo.fullName, now, db, repo.createdAt ?? null)
  }
}

/**
 * Record a single ecology snapshot.
 * Skips insert if the most recent snapshot for this repo is within the minimum interval.
 *
 * The interval check and insert run inside a transaction so the guard
 * is atomic — prevents duplicate snapshots if the deployment model
 * ever changes from synchronous single-process.
 */
/** What a snapshot is recorded for: the ecology and, when known, its identity. */
export type SnapshotSubject = RepositoryEcology & { githubId?: number }

export function recordSnapshot(
  ecology: SnapshotSubject,
  signals?: StructuralSignals,
  density?: DensityObservation,
  db: GroveDb = getDb(),
): boolean {
  const now = new Date()
  // Wrap check+insert in a transaction for atomicity.
  // better-sqlite3 transactions acquire an EXCLUSIVE lock, so concurrent
  // callers (if any) block until this completes.
  return db.transaction(() => {
    if (isWithinInterval(ecology.fullName, now, db, ecology.githubId)) return false
    db.insert(ecologySnapshots)
      .values(buildSnapshotValues(ecology, signals, density, now))
      .run()
    extendBindingForName(ecology.fullName, now.toISOString(), db)
    return true
  })
}

/**
 * Record ecology snapshots for multiple repositories in a single transaction.
 * Interval check and inserts are all inside the transaction for atomicity.
 * Returns the names a snapshot was recorded for; the others were within
 * the interval (present, unchanged).
 */
export function recordSnapshotBatch(
  entries: Array<{
    ecology: SnapshotSubject
    signals?: StructuralSignals
    density?: DensityObservation
  }>,
  db: GroveDb = getDb(),
): Set<string> {
  const now = new Date()
  const recorded = new Set<string>()
  db.transaction(() => {
    for (const { ecology, signals, density } of entries) {
      if (isWithinInterval(ecology.fullName, now, db, ecology.githubId)) continue
      db.insert(ecologySnapshots)
        .values(buildSnapshotValues(ecology, signals, density, now))
        .run()
      extendBindingForName(ecology.fullName, now.toISOString(), db)
      recorded.add(ecology.fullName)
    }
  })
  return recorded
}

/**
 * Get the most recent snapshot for a repository.
 */
export function getLatestSnapshot(fullName: string, db: GroveDb = getDb()) {
  return (
    db
      .select()
      .from(ecologySnapshots)
      .where(eq(ecologySnapshots.fullName, fullName))
      .orderBy(desc(ecologySnapshots.observedAt))
      .limit(1)
      .get() ?? null
  )
}

/**
 * Get snapshot history for a repository, ordered by observed_at DESC.
 */
export function getSnapshotHistory(fullName: string, limit = 100, db: GroveDb = getDb()) {
  return db
    .select()
    .from(ecologySnapshots)
    .where(eq(ecologySnapshots.fullName, fullName))
    .orderBy(desc(ecologySnapshots.observedAt))
    .limit(limit)
    .all()
}

// ── Internal helpers ──────────────────────────────────────────────

function isWithinInterval(
  fullName: string,
  now: Date,
  db: GroveDb,
  githubId?: number,
): boolean {
  // Only this identity's own snapshots under this name throttle: rows that
  // recorded the identity are matched by it and the name; rows without one
  // only within the name's current segment. A name just taken over by
  // another repository has no snapshot of its own yet, and a repository
  // observed under a new name records its first row there.
  const segmentStart = currentSegmentStart(fullName, db)
  const byName =
    segmentStart === undefined
      ? eq(ecologySnapshots.fullName, fullName)
      : and(eq(ecologySnapshots.fullName, fullName), gte(ecologySnapshots.observedAt, segmentStart))
  // Both arms stay inside the current segment: an identity returning to a
  // name after another held it starts afresh too. With no segment at all,
  // unbound rows under the name are nobody's yet — only tagged rows count.
  // Only contemporaneous observations throttle: a row recorded from history
  // (dated at a day's end) is not a recent look at the repository.
  const own =
    githubId === undefined
      ? byName
      : segmentStart === undefined
        ? and(eq(ecologySnapshots.fullName, fullName), eq(ecologySnapshots.githubId, githubId))
        : and(byName, or(eq(ecologySnapshots.githubId, githubId), isNull(ecologySnapshots.githubId)))
  const latest = db
    .select({ observedAt: ecologySnapshots.observedAt })
    .from(ecologySnapshots)
    .where(and(own, eq(ecologySnapshots.method, 'observed')))
    .orderBy(desc(ecologySnapshots.observedAt))
    .limit(1)
    .get()

  if (!latest) return false
  const elapsed = now.getTime() - new Date(latest.observedAt).getTime()
  return elapsed < MIN_SNAPSHOT_INTERVAL_MS
}

function buildSnapshotValues(
  ecology: SnapshotSubject,
  signals: StructuralSignals | undefined,
  density: DensityObservation | undefined,
  now: Date,
) {
  return {
    fullName: ecology.fullName,
    githubId: ecology.githubId ?? null,
    observedAt: now.toISOString(),
    classified: ecology.classified,
    intent: ecology.declaration?.intent ?? null,
    horizon: ecology.declaration?.horizon ?? null,
    role: ecology.declaration?.role ?? null,
    phase: ecology.declaration?.phase ?? null,
    steward: ecology.declaration?.steward ?? null,
    consolidationIntervalDays: ecology.declaration?.consolidation_interval_days ?? null,
    fileCount: signals?.fileCount ?? null,
    commitsLast30d: signals?.commitsLast30d ?? null,
    commitsLast90d: signals?.commitsLast90d ?? null,
    dependencyManifestsObserved: signals?.dependencyManifestsObserved
      ? JSON.stringify(signals.dependencyManifestsObserved)
      : null,
    ecosystemDependencyCount: signals?.ecosystemDependencyCount ?? null,
    densityTier: density?.tier ?? null,
    densityDescription: density?.description ?? null,
  }
}

/**
 * Maximum snapshots per day, derived from MIN_SNAPSHOT_INTERVAL_MS.
 * Used to over-fetch from getSnapshotHistory so day-deduplication
 * covers the full window even when multiple snapshots exist per day.
 * Derived rather than hardcoded so changes to the interval policy
 * automatically adjust the fetch multiplier.
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000
const MAX_SNAPSHOTS_PER_DAY = Math.ceil(MS_PER_DAY / MIN_SNAPSHOT_INTERVAL_MS)

/**
 * Fetch the last N *daily* snapshots for each repository in a portfolio.
 * Returns a Map keyed by fullName with one snapshot per calendar day (UTC),
 * most-recent-per-day, ordered DESC.
 *
 * The contract defines persistence as "in the last 14 daily snapshots"
 * (§4.2/§4.3), so intra-day duplicates are collapsed — the most recent
 * snapshot per UTC day is retained.
 *
 * Delegates to getSnapshotHistory per repo — portfolio sizes are small
 * (typically <30 repos), so sequential indexed lookups are efficient.
 */
export function getPortfolioSnapshotWindow(
  fullNames: string[],
  windowSize = 14,
  db: GroveDb = getDb(),
): Map<string, ReturnType<typeof getSnapshotHistory>> {
  const safeWindowSize = Math.max(0, Math.floor(windowSize))
  const result = new Map<string, ReturnType<typeof getSnapshotHistory>>()
  for (const name of fullNames) {
    // Over-fetch to account for multiple snapshots per day, then deduplicate.
    const rows = getSnapshotHistory(name, safeWindowSize * MAX_SNAPSHOTS_PER_DAY, db)
    result.set(name, deduplicateByDay(rows, safeWindowSize))
  }
  return result
}

/**
 * Deduplicate snapshot rows to one per UTC calendar day.
 * Rows must be ordered DESC (most recent first) — the first row
 * encountered for each day is kept.
 */
function deduplicateByDay<T extends { observedAt: string }>(
  rows: T[],
  limit: number,
): T[] {
  if (limit <= 0) return []
  const seen = new Set<string>()
  const result: T[] = []
  for (const row of rows) {
    const day = row.observedAt.slice(0, 10) // 'YYYY-MM-DD' from ISO 8601
    if (seen.has(day)) continue
    seen.add(day)
    result.push(row)
    if (result.length >= limit) break
  }
  return result
}

// ── Calendar-anchored windows ────────────────────────────────────

export type SnapshotRow = typeof ecologySnapshots.$inferSelect

/** A repository to window: by identity when known, otherwise by its current name. */
export interface WindowSubject {
  fullName: string
  githubId?: number
}

/**
 * §4.1 — One calendar window per repository: `days` consecutive UTC days
 * ending at `endDay` (inclusive), most recent first, one slot per day.
 * Days without an observation are explicit (`snapshot: undefined`); a long
 * absence therefore yields a window of mostly empty slots instead of a
 * window stitched from whichever days happen to exist.
 *
 * When the subject's identity is known, rows are gathered by identity: by
 * `github_id` where recorded, and across every name bound to it only within
 * those bounds — never past them, so a reused name cannot lend another
 * identity's rows. Only a subject with no known identity reads by its name.
 */
export function getPortfolioCalendarWindow(
  subjects: WindowSubject[],
  endDay: string,
  days: number,
  db: GroveDb = getDb(),
): Map<string, CalendarSlot<SnapshotRow>[]> {
  const safeDays = Math.max(0, Math.floor(days))
  const since = `${shiftDay(endDay, -(safeDays - 1))}T00:00:00.000Z`
  const result = new Map<string, CalendarSlot<SnapshotRow>[]>()

  for (const subject of subjects) {
    const rows =
      subject.githubId !== undefined
        ? getSnapshotHistoryForIdentity(subject.githubId, { since }, db)
        : db
          .select()
          .from(ecologySnapshots)
          .where(
            and(
              eq(ecologySnapshots.fullName, subject.fullName),
              gte(ecologySnapshots.observedAt, since),
            ),
          )
          .orderBy(desc(ecologySnapshots.observedAt))
          .all()

    result.set(subject.fullName, buildCalendarWindow(rows, endDay, safeDays))
  }
  return result
}

export { MIN_SNAPSHOT_INTERVAL_MS }
