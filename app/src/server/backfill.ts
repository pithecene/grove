import type { GroveDeclaration, StructuralSignals } from '@grove/core'
import {
  observeConsolidationInterval,
  observeStructuralDensity,
  parseGroveYaml,
  shiftDay,
  toUtcDay,
} from '@grove/core'
import { classifyTree, countEcosystemDependencies } from '@grove/github'
import { and, eq, gte, lte, or } from 'drizzle-orm'

import type { BindingRow, GroveDb } from './db'
import {
  finishRun,
  getBindingsForIdentity,
  getDb,
  getDeclarationHistoryForIdentity,
  recordRunRepository,
  startRun,
} from './db'
import { declarationChanges, ecologySnapshots } from './db/schema'
import type { HistoryCommit, HistorySource } from './history/source'
import { listIdentities } from './identities'
import type { PortfolioScope } from './scope'

/** Version of the reconstruction algorithm, recorded on every row it writes. */
export const RECONSTRUCTION_ALGORITHM = 'history-v1'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const dayEnd = (day: string) => `${day}T23:59:59.999Z`

/** Why each reconstructed row differs from a live observation, stated on the row. */
export const DIVERGENCES = [
  'branch_state: retrospective — first-parent history as the default branch now records it',
  'commit windows: trailing 30/90 calendar days by committer date (live: GitHub weekly buckets)',
  'consolidation: last first-parent commit date in place of pushed_at; clock = end of day',
  'ecosystem dependencies: resolved against in-scope repositories known to exist on the day, under the names they held',
  'density: computed with the current algorithm at backfill time',
] as const

export interface BackfillTarget {
  githubId: number
  fullName: string
  defaultBranch: string
  createdAt: string | null
}

export interface BackfillEntry {
  fullName: string
  githubId: number
  /** Days in range with no snapshot of either method before this run */
  daysToFill: number
  /** Days written (apply) or that would be written (dry run) from a tree */
  daysFromTree: number
  /** Days written as existing-but-empty (after `created_at`, before the first commit) */
  daysEmpty: number
  /** Days before the repository existed, left empty */
  daysBeforeCreation: number
  /** Days with no commit yet and no creation evidence: unknown, left empty */
  daysUnknown: number
  /** Declaration rows written (apply) or that would be written (dry run) */
  declarations: number
  commitsInRange: number
  message?: string
}

export interface BackfillReport {
  recordedAt: string
  apply: boolean
  from: string
  to: string
  runId?: number
  entries: BackfillEntry[]
}

export interface BackfillOptions {
  /** First UTC day to fill (inclusive) */
  from: string
  /** Last UTC day to fill (inclusive); never later than the previous UTC day */
  to?: string
  /** Current repository names to limit the backfill to */
  names?: string[]
  /** false = dry run: plan and report, write nothing */
  apply: boolean
  scope?: PortfolioScope
  /** Opens the history of one target */
  sourceFor: (target: BackfillTarget) => Promise<HistorySource>
  now?: () => Date
}

/** Last UTC day that may be backfilled: the day before `now`. */
export function lastBackfillDay(now: Date): string {
  return shiftDay(toUtcDay(now.toISOString()), -1)
}

/** One target per identity in scope (see `listIdentities`). */
function listTargets(db: GroveDb, options: BackfillOptions): BackfillTarget[] {
  return listIdentities(db, options.scope, options.names).map(
    ({ githubId, fullName, defaultBranch, createdAt }) => ({
      githubId,
      fullName,
      defaultBranch,
      createdAt,
    }),
  )
}

type NameBasis = 'binding' | 'later_binding' | 'current_name'

/**
 * The name an identity held over [start, end]: the binding segment in force
 * — the latest to begin when several overlap (a rename within the span) —
 * else the nearest later one, else the current name.
 */
function nameOver(
  bindings: BindingRow[],
  start: string,
  end: string,
  current: string,
): { fullName: string; basis: NameBasis } {
  const inForce = bindings
    .filter((b) => b.firstObservedAt <= end && b.lastObservedAt >= start)
    .sort((a, b) => b.firstObservedAt.localeCompare(a.firstObservedAt))[0]
  if (inForce) return { fullName: inForce.fullName, basis: 'binding' }
  const later = bindings
    .filter((b) => b.firstObservedAt > end)
    .sort((a, b) => a.firstObservedAt.localeCompare(b.firstObservedAt))[0]
  if (later) return { fullName: later.fullName, basis: 'later_binding' }
  return { fullName: current, basis: 'current_name' }
}

/** The name an identity held on `day`. */
const nameOn = (bindings: BindingRow[], day: string, current: string) =>
  nameOver(bindings, `${day}T00:00:00.000Z`, dayEnd(day), current)

/** The name an identity held at `instant` (a commit). */
const nameAt = (bindings: BindingRow[], instant: string, current: string) =>
  nameOver(bindings, instant, instant, current)

/** Days in [from, to] that already have a snapshot of either method for the identity. */
function daysWithSnapshot(db: GroveDb, target: BackfillTarget, from: string, to: string): Set<string> {
  const bindings = getBindingsForIdentity(target.githubId, db)
  const byName = bindings.map((b) =>
    and(
      eq(ecologySnapshots.fullName, b.fullName),
      gte(ecologySnapshots.observedAt, b.firstObservedAt),
      lte(ecologySnapshots.observedAt, b.lastObservedAt),
    ),
  )
  const identity =
    byName.length > 0
      ? or(eq(ecologySnapshots.githubId, target.githubId), ...byName)
      : eq(ecologySnapshots.githubId, target.githubId)
  const rows = db
    .select({ observedAt: ecologySnapshots.observedAt })
    .from(ecologySnapshots)
    .where(
      and(
        identity,
        gte(ecologySnapshots.observedAt, `${from}T00:00:00.000Z`),
        lte(ecologySnapshots.observedAt, dayEnd(to)),
      ),
    )
    .all()
  return new Set(rows.map((r) => toUtcDay(r.observedAt)))
}

/**
 * The ecosystem on `day`: the in-scope repositories (the same set a live
 * observation counts against) that existed by then, under the names they
 * held. A repository whose creation date is not known makes the day's
 * membership unknown (`undefined`) rather than a guess: a dependency count
 * is never persisted from a fact that is not there.
 */
function ecosystemNamesOn(db: GroveDb, day: string, scope: PortfolioScope | undefined): string[] | undefined {
  const end = dayEnd(day)
  // One member per identity, former names resolved through bindings and
  // creation taken from whichever row carries it (`listIdentities`).
  const names: string[] = []
  for (const member of listIdentities(db, scope)) {
    if (!member.createdAt) return undefined
    if (member.createdAt > end) continue
    names.push(nameOn(getBindingsForIdentity(member.githubId, db), day, member.fullName).fullName)
  }
  return names
}

function countCommitsWithin(commits: HistoryCommit[], end: string, days: number): number {
  const endMs = new Date(end).getTime()
  const startMs = endMs - days * MS_PER_DAY
  return commits.filter((c) => {
    const t = new Date(c.committedAt).getTime()
    return t > startMs && t <= endMs
  }).length
}

function declarationOf(raw: string | undefined): GroveDeclaration | undefined {
  if (!raw) return undefined
  const parsed = parseGroveYaml(raw)
  return parsed.ok ? parsed.declaration : undefined
}

/** Canonical form of a declaration (or its absence) for change detection. */
const keyOf = (d: GroveDeclaration | undefined) =>
  JSON.stringify({
    classified: d !== undefined,
    consolidation_interval_days: d?.consolidation_interval_days ?? null,
    horizon: d?.horizon ?? null,
    intent: d?.intent ?? null,
    phase: d?.phase ?? null,
    role: d?.role ?? null,
    steward: d?.steward ?? null,
  })

function rowToDeclaration(row: typeof declarationChanges.$inferSelect): GroveDeclaration | undefined {
  if (!row.classified) return undefined
  return {
    intent: row.intent ?? '',
    ...(row.horizon ? { horizon: row.horizon as GroveDeclaration['horizon'] } : {}),
    ...(row.role ? { role: row.role as GroveDeclaration['role'] } : {}),
    ...(row.phase ? { phase: row.phase as GroveDeclaration['phase'] } : {}),
    ...(row.steward ? { steward: row.steward } : {}),
    ...(row.consolidationIntervalDays != null
      ? { consolidation_interval_days: row.consolidationIntervalDays }
      : {}),
  }
}

/**
 * Reconstruct the daily series for each target from its own history.
 *
 * For every UTC day in range without a snapshot (of either method):
 * - the selected commit is the latest-dated first-parent commit at or
 *   before the end of the day; the tree there is classified with the same
 *   definition the live fetch uses; `.grove.yaml` there is the day's
 *   declaration;
 * - a day at or after `created_at` with no commit yet is recorded as the
 *   repository existing but empty; a day before `created_at` is left empty;
 *   a day with no commit and no creation evidence is unknown and left empty;
 * - every first-parent commit of that day that changed `.grove.yaml`
 *   yields its own declaration row when the declaration differs from the
 *   chronologically previous one (the same rule in dry run and apply);
 * - the day's rows commit in one transaction — a complete day or nothing.
 *
 * Rows carry `method = 'history'`, the identity, `recorded_at`, the run,
 * and evidence (sha, committer date, `branch_state: retrospective`, state,
 * algorithm, divergences). The range never includes the current day. A
 * target whose history cannot be read is reported on the run; the rest
 * proceed.
 */
export async function backfillHistory(
  db: GroveDb,
  options: BackfillOptions,
): Promise<BackfillReport> {
  const now = options.now ?? (() => new Date())
  const recordedAt = now().toISOString()
  const latest = lastBackfillDay(now())
  const to = options.to && options.to < latest ? options.to : latest
  const from = options.from
  if (from > to) {
    return { recordedAt, apply: options.apply, from, to, entries: [] }
  }

  const targets = listTargets(db, options)
  const runId = options.apply
    ? startRun(
        { method: 'backfill', fullPortfolio: options.names === undefined, scope: options.scope },
        db,
      )
    : undefined
  const entries: BackfillEntry[] = []

  for (const target of targets) {
    const entry: BackfillEntry = {
      fullName: target.fullName,
      githubId: target.githubId,
      daysToFill: 0,
      daysFromTree: 0,
      daysEmpty: 0,
      daysBeforeCreation: 0,
      daysUnknown: 0,
      declarations: 0,
      commitsInRange: 0,
    }
    entries.push(entry)

    let wroteAny = false
    try {
      wroteAny = await reconstructTarget(db, options, target, entry, from, to, recordedAt, runId)
    } catch (err) {
      // Whatever the history could not answer — opening it, listing commits,
      // reading a tree or a file — the target is reported, never guessed,
      // and the others proceed.
      entry.message = `history unavailable: ${err instanceof Error ? err.message : String(err)}`
      if (runId !== undefined) {
        recordRunRepository(
          runId,
          { githubId: target.githubId, fullName: target.fullName, outcome: 'unavailable', answer: 'history' },
          db,
        )
      }
      continue
    }

    if (runId !== undefined) {
      recordRunRepository(
        runId,
        { githubId: target.githubId, fullName: target.fullName, outcome: wroteAny ? 'observed' : 'unchanged' },
        db,
      )
    }
  }

  if (runId !== undefined) finishRun(runId, { complete: true }, db)
  return { recordedAt, apply: options.apply, from, to, runId, entries }
}

/** Reconstruct one target; returns whether any day was written. */
async function reconstructTarget(
  db: GroveDb,
  options: BackfillOptions,
  target: BackfillTarget,
  entry: BackfillEntry,
  from: string,
  to: string,
  recordedAt: string,
  runId: number | undefined,
): Promise<boolean> {
  // Nothing to fill means nothing to read: a re-run over a covered range
  // never depends on the history being reachable.
  const existing = daysWithSnapshot(db, target, from, to)
  let anyMissing = false
  for (let day = from; day <= to; day = shiftDay(day, 1)) {
    if (!existing.has(day)) {
      anyMissing = true
      break
    }
  }
  if (!anyMissing) return false

  const source = await options.sourceFor(target)

  // Dates, not traversal order, decide which commit a day sees: first-parent
  // order is not guaranteed to be chronological (imports, clock skew).
  const byDate = (a: HistoryCommit, b: HistoryCommit) => a.committedAt.localeCompare(b.committedAt)
  const commits = (await source.firstParentCommits()).sort(byDate)
  const declarationCommits = (await source.commitsTouching('.grove.yaml')).sort(byDate)
  const bindings = getBindingsForIdentity(target.githubId, db)
  const fromMs = new Date(`${from}T00:00:00.000Z`).getTime()
  const toMs = new Date(dayEnd(to)).getTime()
  entry.commitsInRange = commits.filter((c) => {
    const t = new Date(c.committedAt).getTime()
    return t >= fromMs && t <= toMs
  }).length

  // The chronologically previous declaration, from what is stored and from
  // what this run has already decided (written in apply, planned in dry run).
  // The baseline is seeded from the last `.grove.yaml` commit before the
  // range, so a change inside it is compared with what preceded it, not
  // with nothing.
  let planned: { observedAt: string; key: string } | undefined
  const rangeStart = `${from}T00:00:00.000Z`
  const baseline = [...declarationCommits].reverse().find((c) => c.committedAt < rangeStart)
  if (baseline) {
    planned = {
      observedAt: baseline.committedAt,
      key: keyOf(declarationOf(await source.fileAt(baseline.sha, '.grove.yaml'))),
    }
  }
  const previousKeyAt = (committedAt: string): string | undefined => {
    const stored = getDeclarationHistoryForIdentity(target.githubId, 100_000, db).find(
      (d) => d.observedAt <= committedAt,
    )
    const storedAt = stored?.observedAt
    if (planned && planned.observedAt <= committedAt && (!storedAt || planned.observedAt >= storedAt)) {
      return planned.key
    }
    return stored ? keyOf(rowToDeclaration(stored)) : undefined
  }

  let wroteAny = false
  for (let day = from; day <= to; day = shiftDay(day, 1)) {
    if (existing.has(day)) continue
    const end = dayEnd(day)
    // Before the repository existed nothing is written, whatever the
    // commit dates say (imported history may predate creation).
    if (target.createdAt && target.createdAt > end) {
      entry.daysBeforeCreation++
      continue
    }
    // The latest-dated commit at or before the day's end.
    let tip: HistoryCommit | undefined
    for (const c of commits) {
      if (c.committedAt <= end) tip = c
      else break
    }
    if (!tip && !target.createdAt) {
      // No commit yet and no creation evidence: unknown, not "did not exist".
      entry.daysUnknown++
      continue
    }
    // The day is counted only once it is planned (dry run) or committed (apply).
    const count = (declarations: number) => {
      entry.daysToFill++
      if (tip) entry.daysFromTree++
      else entry.daysEmpty++
      entry.declarations += declarations
    }

    // Declarations of the day, one per commit that changed `.grove.yaml`
    // and whose declaration differs from the previous one — decided the
    // same way whether or not anything is written.
    const dayDeclarations: Array<{ commit: HistoryCommit; declaration: GroveDeclaration | undefined }> = []
    for (const commit of declarationCommits.filter((c) => toUtcDay(c.committedAt) === day)) {
      const declaration = declarationOf(await source.fileAt(commit.sha, '.grove.yaml'))
      const key = keyOf(declaration)
      if (previousKeyAt(commit.committedAt) === key) continue
      dayDeclarations.push({ commit, declaration })
      planned = { observedAt: commit.committedAt, key }
    }
    if (!options.apply) {
      count(dayDeclarations.length)
      continue
    }

    const name = nameOn(bindings, day, target.fullName)
    let signals: StructuralSignals | undefined
    let declaration: GroveDeclaration | undefined
    if (tip) {
      const tree = await source.treeAt(tip.sha)
      const classified = classifyTree(tree)
      const packageJson = classified.hasRootPackageJson
        ? await source.fileAt(tip.sha, 'package.json')
        : undefined
      const ecosystem = packageJson === undefined ? undefined : ecosystemNamesOn(db, day, options.scope)
      signals = {
        fileCount: classified.fileCount,
        commitsLast30d: countCommitsWithin(commits, end, 30),
        commitsLast90d: countCommitsWithin(commits, end, 90),
        dependencyManifestsObserved: classified.manifests,
        ecosystemDependencyCount:
          packageJson === undefined || ecosystem === undefined
            ? undefined
            : countEcosystemDependencies(packageJson, ecosystem),
        readmePresent: classified.readmePresent,
        contributingPresent: classified.contributingPresent,
        licensePresent: classified.licensePresent,
        docsDirectoryPresent: classified.docsDirectoryPresent,
        ciConfigPresent: classified.ciConfigPresent,
        testDirectoryPresent: classified.testDirectoryPresent,
        testFilePatternsObserved: classified.testFilePatternsObserved,
        observedAt: end,
      }
      declaration = declarationOf(await source.fileAt(tip.sha, '.grove.yaml'))
    }
    const consolidation = tip
      ? observeConsolidationInterval(
          declaration?.consolidation_interval_days,
          new Date(tip.committedAt),
          new Date(end),
        )
      : undefined
    const density = signals ? observeStructuralDensity(signals, consolidation) : undefined

    const evidence = {
      sha: tip?.sha ?? null,
      committed_at: tip?.committedAt ?? null,
      branch_state: 'retrospective',
      state: tip ? 'tree' : 'empty',
      name_basis: name.basis,
      algorithm: RECONSTRUCTION_ALGORITHM,
      divergences: DIVERGENCES,
    }

    db.transaction(() => {
      db.insert(ecologySnapshots)
        .values({
          fullName: name.fullName,
          githubId: target.githubId,
          observedAt: end,
          method: 'history',
          recordedAt,
          collectionRunId: runId ?? null,
          evidence: JSON.stringify(evidence),
          classified: declaration !== undefined,
          intent: declaration?.intent ?? null,
          horizon: declaration?.horizon ?? null,
          role: declaration?.role ?? null,
          phase: declaration?.phase ?? null,
          steward: declaration?.steward ?? null,
          consolidationIntervalDays: declaration?.consolidation_interval_days ?? null,
          fileCount: signals?.fileCount ?? null,
          commitsLast30d: signals?.commitsLast30d ?? null,
          commitsLast90d: signals?.commitsLast90d ?? null,
          dependencyManifestsObserved: signals?.dependencyManifestsObserved
            ? JSON.stringify(signals.dependencyManifestsObserved)
            : null,
          ecosystemDependencyCount: signals?.ecosystemDependencyCount ?? null,
          densityTier: density?.tier ?? null,
          densityDescription: density?.description ?? null,
        })
        .run()

      for (const { commit, declaration: declared } of dayDeclarations) {
        db.insert(declarationChanges)
          .values({
            fullName: nameAt(bindings, commit.committedAt, target.fullName).fullName,
            githubId: target.githubId,
            observedAt: commit.committedAt,
            method: 'history',
            recordedAt,
            collectionRunId: runId ?? null,
            evidence: JSON.stringify({ sha: commit.sha, committed_at: commit.committedAt, path: '.grove.yaml' }),
            classified: declared !== undefined,
            intent: declared?.intent ?? null,
            horizon: declared?.horizon ?? null,
            role: declared?.role ?? null,
            phase: declared?.phase ?? null,
            steward: declared?.steward ?? null,
            consolidationIntervalDays: declared?.consolidation_interval_days ?? null,
          })
          .run()
      }
    })
    count(dayDeclarations.length)
    wroteAny = true
  }
  return wroteAny
}

export { getDb }
